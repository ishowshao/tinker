# Runtime Contract 收缩与 Context Surface Refresh 技术方案

## 文档状态

- 日期：2026-07-17
- 状态：已审阅，设计决策已确认，待实施；本文不代表实施授权
- 当前基线：SessionStore schema v5、`RuntimeContractV1`、不可变 canonical history、
  `initial_full` / `swap_only` ContextRevision、手动 `/compact`
- 相关设计：
  [`session-store-resume-design.md`](session-store-resume-design.md)、
  [`project-instructions-loading-design.md`](project-instructions-loading-design.md)、
  [`context-revision-i2-deterministic-swap-manual-compact-design.md`](context-revision-i2-deterministic-swap-manual-compact-design.md)

## 一、结论

当前 `RuntimeContractV1` 同时承担了“历史消息协议兼容”“当前模型输入完全相同”和
“运行策略完全相同”三类职责。结果是：一部分变化直接阻断 `/resume`，另一部分变化为了
避免阻断而读取历史快照，导致恢复后的 Tinker 长期使用旧 system prompt 和旧项目指令。

本方案把边界拆成四层：

1. **SessionCompatibilityContract** 只回答当前 model adapter 能否继续解释并发送历史
   messages；不再冻结 system prompt、工具面、endpoint 或产品策略。
2. **ContextSurface** 保存某个 ContextRevision 实际使用的 system prompt、项目指令摘要、
   tool definitions 和非秘密 request fingerprint。
3. **Runtime policy** 在每次 activation 时由当前代码重新计算，包括 context budget、trigger
   ratio、trigger tokens、compaction policy 和 `maxIterations`。
4. **Per-record format** 由每条历史记录自己保存，例如 tool observation format；升级当前
   renderer 不重写旧 observation，也不阻断整个 session。

本方案采用以下具体决定：

1. 删除 runtime contract 中没有独立兼容意义的 `version` 字段。Session schema fingerprint
   继续负责存储格式识别；model message serialization version 继续保留，因为它代表真实协议。
2. contract 保留 `modelName`、`profileName`、`includeReasoningContent`、
   `contextProfile` 和明确的 model message protocol identity。
3. 完整 `contextBudget` 移出 contract，每次 activation 从当前产品策略重新派生。
4. `systemPromptSha256` 移出 contract。创建时的 system message 继续作为 immutable creation
   snapshot 保存；恢复时加载当前 runtime instructions 和当前 AGENTS.md/CLAUDE.md。
5. 完整 `toolSchemaSha256` 移到 ContextSurface，不再作为 session-wide gate。
   这样有意增加、移除或升级 MCP 时创建新的 surface revision，不修改历史 tool frames。
6. `requestConfigSha256` 不再作为 opaque session-wide gate。model adapter 暴露明确的历史消息
   protocol identity；runtime request fingerprint 仍用于 prefix、measurement 和 surface 比较。
7. API base URL、API key、timeout、transport 和当前 fetch 实现都不进入 compatibility contract，
   也不进入跨 activation 的 request identity。
8. `observationFormat` 移出 contract，继续保存在每条 `tool_results` 记录中；decoder 同时支持
   所有仍受支持的历史格式，未知格式 fast-fail。
9. 新增 immutable `ContextSurface` 和 `surface_refresh` ContextRevision。surface 改变时允许
   一次有记录的 prefix 重建；同一个 revision 内仍必须严格 append。
10. 仅在新建 session 或 `/resume` activation 时检查并刷新 surface；本阶段不监听文件变化，
    不在每个 turn 前重新读取 AGENTS.md，也不新增 `/refresh`。
11. 已配置 MCP server 的连接或 `listTools()` 失败必须 fast-fail，不能把临时故障误判成有意
    移除工具并提交 surface revision。
12. 一次性切换到 SessionStore schema v6，不实现 v5/v6 dual-read、fallback 或 runtime
    migration。

## 二、问题定义

### 2.1 当前 runtime contract 的职责过宽

当前 `RuntimeContractV1` 包含：

```ts
type RuntimeContractV1 = {
  version: 1;
  modelName: string;
  profileName?: string;
  includeReasoningContent: boolean;
  contextProfile: ModelContextProfile;
  contextBudget: ModelContextBudget;
  systemPromptSha256: string;
  toolSchemaSha256: string;
  requestConfigSha256: string;
  observationFormat: "tool-observation-v2";
};
```

`SessionStore.assertRuntimeContract()` 对 stable JSON 和 SHA-256 做 exact match。它无法表达：

- 某项变化会使历史 messages 无法被当前 adapter 接受；
- 某项变化只需要重建当前模型输入；
- 某项变化只是新的产品调度策略；
- 某项变化只影响将来新增的记录，不影响历史记录。

### 2.2 当前 system prompt 通过旧快照绕开 mismatch

新 session 会把当前 `RUNTIME_INSTRUCTIONS(workspaceRoot)` 和当前 AGENTS.md/CLAUDE.md
合成为唯一 system message。`/resume` 不读取当前文件，而是调用
`readStoredSystemPrompt()`，使用 creation snapshot 重算相同的 `systemPromptSha256`。

因此当前行为不是“当前 prompt 与历史 prompt 兼容”，而是“永远继续使用历史 prompt”：

- AGENTS.md 修改、删除或新增不会进入 resumed session；
- Tinker 内置 runtime instructions 更新不会进入 resumed session；
- contract 能通过，但系统能力是旧副本。

仅从 contract 删除 `systemPromptSha256` 不能解决问题。当前 compiler 仍从 canonical ordinal 1
读取旧 system message，SQLite 也禁止修改该 message 和 `session_meta.system_prompt_sha256`。

### 2.3 当前 tool schema 会把 MCP 变化变成 resume failure

每次 resume 都重新加载当前 MCP config、连接 server、调用 `listTools()`，再把当前 MCP
definitions 与 built-in tools 一起计算 `toolSchemaSha256`。因此：

- 增加或移除一个实际暴露工具的 MCP 会阻断 resume；
- MCP description、input schema 或返回顺序变化会阻断 resume；
- 原来存在的 MCP 临时连接失败时，当前实现跳过该 server，最终也会因 schema 缺失而阻断；
- timeout、observation length 等 executor 参数变化，只要 definitions 相同就不会被发现。

MCP 是动态 capability，不能同时被当成 session 永久身份。

### 2.4 当前 context budget 冻结了产品策略

`contextBudget` 同时保存 provider/request 参数与产品调度参数：

```text
contextWindowTokens
maxSupportedOutputTokens
requestMaxOutputTokens
inputBudgetTokens
triggerRatio
triggerTokens
```

例如 trigger ratio 从 `0.8` 调整为 `0.4`，历史 messages 仍然合法，但 exact contract 会使
全部旧 session 无法 resume。正确行为应是允许恢复，再用当前 policy 把一个占用 `0.6` 的
session 重新分类为 `triggered`。

当前自动 context 管理仍只执行 shadow planning，不会在 resume 过程中自动提交 compact
revision。本方案不改变这一阶段边界：policy 变化只重新计算 pressure；真正自动 compact
继续由后续路线图定义。

## 三、术语与所有权

### 3.1 Canonical history

SessionStore 中 immutable 的 frames、messages 和 tool results。它们记录已经发生的历史事实，
不因 prompt、MCP、renderer 或产品策略升级而重写。

### 3.2 SessionCompatibilityContract

当前 runtime 是否能忠实解释并继续发送 canonical history 的最小协议契约。contract mismatch
仍然 fast-fail，并且发生在 provider request、tool execution 和 canonical recovery mutation
之前。

### 3.3 ContextSurface

某个 ContextRevision 实际发送给模型的静态输入面：

- active system prompt；
- 当前 project-instruction manifest；
- 当前 model-visible tool definitions；
- 当前非秘密 request fingerprint；
- 对应的 hashes。

ContextSurface 是 immutable snapshot，不是每次请求临时读取的全局配置。

### 3.4 ContextRevision

模型当前看到的上下文视图版本。canonical history 不变，revision 决定 system message、
swapped observation 和 tool surface 如何组成当前请求。

当前实现只有：

- `initial_full`；
- `swap_only`。

本方案新增：

- `surface_refresh`。

`surface_refresh` 是本方案定义的新能力，不是对当前代码行为的描述。

### 3.5 Runtime policy

每次 activation 使用当前代码和当前 profile 计算的调度参数，例如：

- `requestMaxOutputTokens`；
- `inputBudgetTokens`；
- `triggerRatio` / `triggerTokens`；
- swap/compaction planning policy；
- `maxIterations`。

policy 可以改变 resume 后的动作，但不能决定 session 是否有资格被打开。

### 3.6 Per-record format

只解释某条 durable record 的格式版本。tool observation format 属于这里；它不是整个 session
的 runtime identity。

## 四、目标与非目标

### 4.1 目标

1. 让 contract 只包含历史 messages 的真实兼容边界。
2. 允许当前 runtime instructions 和当前 AGENTS.md/CLAUDE.md 在 resume 时生效。
3. 允许有意增加、移除和升级 MCP，而不重写历史 tool calls/results。
4. 允许 trigger ratio、budget derivation 和 compaction policy 更新后继续 resume。
5. API endpoint 切换不使同一 profile/model 的历史 session 失效。
6. 历史 observations 保持 byte-stable，不使用当前 renderer 重建。
7. surface 变化必须 durable、可审计、可恢复，并形成明确的新 prefix 边界。
8. 同一 ContextRevision 内继续执行严格 append-only prefix audit。
9. 保留 fast-fail：无效 profile、历史协议不兼容、MCP 初始化失败、未知 observation format、
   schema 或 canonical integrity 失败都必须明确报告。
10. 新 session 与 resumed session 使用同一套 surface builder 和 validation。

### 4.2 非目标

- 不在每个 turn 前读取 AGENTS.md/CLAUDE.md；
- 不实现文件 watcher 或自动 `/refresh`；
- 不在本阶段实现自动 compact revision commit；
- 不重新渲染或批量迁移历史 observation 文本；
- 不修改 canonical user/assistant/tool messages；
- 不允许同一个 session 切换 `modelName`、`profileName` 或 reasoning replay 语义；
- 不实现 small context profile 到 large context profile 的兼容判断；
- 不把 endpoint、API key 或 MCP secret 写入数据库、事件或错误消息；
- 不实现 branching ContextRevision 或 revision rollback；
- 不把 MCP 临时不可用自动解释成有意删除；
- 不提供 v5/v6 runtime fallback。

## 五、核心不变量

```text
Canonical history remains immutable
Creation system prompt remains an immutable historical snapshot
The active model surface belongs to exactly one durable ContextRevision
Every ContextRevision belongs to one linear immutable chain
The active revision is always the latest committed revision
A swap_only revision inherits its parent ContextSurface exactly
A surface_refresh revision inherits all active swap overrides exactly
A surface_refresh never changes canonical messages or tool results
Configured MCP failure never commits a reduced surface
Historical observations are never re-rendered during resume
Unknown historical record formats fail close to decoding
The compatibility contract contains no endpoint, secret, or current policy value
The same revision accepts only strict prompt append
A revision switch clears the measured anchor before activating the new surface
Diagnostic events never contain system prompt, project instruction body, tool schema body, or secrets
```

另一个必须明确的不变量是：修改请求最前面的 system/tool segments 与“相对旧请求仍然严格
append”不能同时成立。surface refresh 是一次显式的 revision boundary；严格 append 从新
revision 的 anchor 重新开始。

## 六、目标 SessionCompatibilityContract

runtime 类型和存储命名统一改成 `SessionCompatibilityContract`，避免继续暗示它包含
所有 runtime 参数：

```ts
type ModelMessageProtocol = {
  adapter: "openai-chat" | "fake";
  serializationVersion: string;
};

type SessionCompatibilityContract = {
  modelName: string;
  profileName?: string;
  includeReasoningContent: boolean;
  contextProfile: ModelContextProfile;
  messageProtocol: ModelMessageProtocol;
};
```

### 6.1 不保留 generic `version`

contract 本身不再包含 `version: 1`。原因是：

- 当前实现没有根据 version 执行 decoder dispatch 或 compatibility migration；
- contract 字段实际变化已经会改变 stable JSON 和 SHA-256；
- schema v6 fingerprint 已经识别 durable storage shape。

这里不删除有实际协议含义的版本。例如 `openai-chat-v1` 表示历史 assistant/tool messages 的
具体序列化规则；更改这套规则必须更新 `serializationVersion`，并使旧 session fast-fail，
除非将来另行设计经过验证的协议迁移。

### 6.2 保留 model/profile 隔离

`modelName` 和 `profileName` 继续 exact match。`profileName` 必须被定义为稳定的语义身份：

- 同一个 profile name 可以更换 endpoint、API key 或 transport；
- 如果 provider family 或历史消息能力发生不兼容变化，应创建新 profile name；
- 仅重命名 profile 会使旧 session 无法 resume，这是有意的身份隔离；
- 没有 profile 配置时，`modelName` 和 adapter identity 共同承担该边界。

API base URL 不再被当成 provider identity。若允许在同一 profile name 下静默切换到不兼容
provider，contract 无法替配置错误兜底；profile 配置文档和校验必须明确这一责任。

### 6.3 保留 reasoning replay 语义

`includeReasoningContent` 会改变历史 assistant message 的 model-visible bytes，继续留在
contract。它不能仅依赖当前 request fingerprint，也不能在 surface refresh 中切换。

### 6.4 保留 exact context profile

`contextProfile` 继续完整 exact match：

```text
contextWindowTokens
maxSupportedOutputTokens
```

理论上 small profile 向 larger profile 恢复可能安全，但本方案不增加方向性兼容判断。配置
通常稳定，exact match 更符合当前 fast-fail 风格。

### 6.5 完整派生 context budget 移出 contract

`deriveModelContextBudget(contextProfile)` 在每次 activation 使用当前代码重新执行。以下值都
不再持久化为 compatibility gate：

```text
requestMaxOutputTokens
inputBudgetTokens
triggerRatio
triggerTokens
```

creation event 可以继续记录当时使用的完整 budget，作为诊断事实；resume projection 和当前
TUI 状态必须使用本次 activation 的 budget，不能从历史 contract 解码旧策略。

### 6.6 contract 比较

contract 继续使用 canonical stable JSON 和 SHA-256 做 exact match，但只比较上述剩余字段。
错误列出变化的语义字段，不打印 profile secret、prompt 或 message 正文。

## 七、request protocol 与 request fingerprint

### 7.1 分离 compatibility identity 与 request fingerprint

当前 `requestConfigSha256` 同时包含 provider、base URL、model、serialization version、output
limit 和 reasoning flag。本方案拆成：

1. `messageProtocol`：进入 SessionCompatibilityContract，表示历史 messages 的 adapter 和
   serialization 语义；
2. `requestConfigHash`：继续存在于 `PreparedModelRequest`，表示本次 activation 的非秘密
   request/prefix identity，但不再直接阻断 session resume。

### 7.2 request fingerprint 的输入

OpenAI chat adapter 应从明确、canonical 的非秘密对象计算 request fingerprint。至少覆盖：

- adapter identity；
- message serialization version；
- model；
- `includeReasoningContent`；
- 当前 `requestMaxOutputTokens`；
- 影响 provider payload 的固定 request policy。

明确排除：

- API base URL，包括 origin、path、query 和 fragment；
- API key；
- timeout；
- transport/fetch 实例；
- proxy、DNS 或部署路由；
- trigger ratio、trigger tokens、compaction policy 和 `maxIterations`。

`requestConfigHash` 仍然用于：

- prompt prefix hash seed；
- CommittedPrefixAuditor；
- measured context anchor；
- swap plan base validation；
- ContextSurface 比较。

request fingerprint 变化时 session 可以 resume，但必须创建 surface revision、清除旧 measured
anchor 并建立新 prefix anchor。只有 `messageProtocol` 变化才属于 session incompatibility。

## 八、ContextSurface

### 8.1 durable shape

新增 immutable `context_surfaces` 表及对应类型：

```ts
type StoredContextSurfaceV6 = {
  surfaceId: ContextSurfaceId;
  sessionId: SessionId;

  systemPrompt: string;
  systemPromptSha256: string;
  projectInstruction?: ProjectInstructionManifest;

  toolDefinitions: readonly ToolDefinition[];
  toolDefinitionsSha256: string;
  toolSchemaSha256: string;

  requestConfigSha256: string;
  requestMaxOutputTokens: number;

  surfaceSha256: string;
  createdAt: string;
};
```

`surfaceSha256` 从不含正文的 canonical manifest 计算：

```ts
{
  systemPromptSha256,
  projectInstruction,
  toolDefinitionsSha256,
  toolSchemaSha256,
  requestConfigSha256,
  requestMaxOutputTokens,
}
```

完整 system prompt 和 tool definitions 仍保存在 mode `0600` 的 session SQLite 中，用于
byte-stable resume、校验和审计；事件、TUI notice 和普通错误只允许输出 manifest、数量和
changed component names。

### 8.2 tool definitions 的确定顺序

当前 tool schema hash 对数组顺序敏感。surface builder 必须产生唯一顺序：

1. built-in tools 使用冻结的 registry 顺序；
2. optional built-in tools 使用固定位置；
3. MCP tools 按最终 model-visible tool name 排序；
4. duplicate final name 立即 fast-fail。

hash 和实际 provider payload 必须使用同一份有序 definitions，不能只在 hash 时排序、发送时
保留另一顺序。

### 8.3 creation snapshot 与 active surface

canonical ordinal 1 system message 和 `session_meta` 中的 project-instruction manifest 继续表示
session 创建时的历史快照。它们不再表示当前 active system prompt。

现有 `readStoredSystemPrompt()` 应收窄并重命名为 creation-snapshot integrity API；resume 不再
把它的返回值直接当作 active system prompt。

每个 ContextRevision 必须引用一个 `surfaceId`：

- revision 1 的 surface 内容与 creation system message 相同；
- `swap_only` 必须继承 parent 的同一个 `surfaceId`；
- `surface_refresh` 必须引用新 surface，并继承 parent 的全部 swap overrides。

## 九、扩展 ContextRevision

### 9.1 新 revision kind

durable union 扩展为：

```ts
type StoredContextRevisionV6 =
  | StoredInitialContextRevisionV6
  | StoredSwapContextRevisionV6
  | StoredSurfaceRefreshContextRevisionV6;
```

所有 revision 新增：

```ts
surfaceId: ContextSurfaceId;
surfaceSha256: string;
```

`surface_refresh` 必须满足：

```ts
type StoredSurfaceRefreshContextRevisionV6 = {
  kind: "surface_refresh";
  revisionNumber: number; // >= 2
  parentRevisionId: ContextRevisionId;
  sourceThroughOrdinal: number; // 当前 closed canonical tail

  addedOverrideCount: 0;
  totalOverrideCount: number; // 与 parent 完全相同
  overrideManifestSha256: string; // 与 parent 完全相同

  surfaceId: ContextSurfaceId; // 新 surface
  surfaceSha256: string;
  changeManifestSha256: string;

  canonicalSequenceSha256: string;
  renderedMessageSha256: string;
  createdAt: string;
};
```

change manifest 只包含布尔变化项，不包含正文：

```ts
type ContextSurfaceChanges = {
  systemPrompt: boolean;
  projectInstruction: boolean;
  toolDefinitions: boolean;
  requestConfig: boolean;
};
```

### 9.2 compiler 语义

`ContextRevisionCompiler` 必须从 `StoredContextSnapshotV6` 同时读取 active surface 和 active
overrides：

1. canonical ordinal 1 仍然必须是唯一、closed、origin=`runtime` 的 creation system record；
2. 编译 active view 时，ordinal 1 的 model-visible content 来自
   `snapshot.surface.systemPrompt`；
3. 其他 canonical messages 保持原样，已换出的 tool messages 使用继承的 swap override；
4. `ContextBuilder` 使用 `snapshot.surface.toolDefinitions`，不再接受任意调用方临时传入另一份
   definitions；
5. 当前 executable registry 的 definitions 必须与 active surface hash 完全一致，才允许进入
   ready 或执行工具；
6. compiled manifest 同时覆盖 canonical sequence、rendered messages 和 surface identity。

`CompiledContextEntry.representation` 至少扩展为：

```ts
"canonical" | "surface" | "swapped"
```

creation revision 中 system content 与 canonical 相同，可以标记为 `canonical`；refresh 后的
active system entry 标记为 `surface`。无论表示如何变化，canonical system record 永远不改。

### 9.3 swap revision 与 surface revision 不合并

本方案不允许一个 revision 同时刷新 surface 并新增 swap overrides：

- resume 需要刷新时先提交一个 `surface_refresh`；
- 用户之后执行 `/compact` 时再提交独立 `swap_only`；
- `swap_only` 必须继承 active surface；
- 每个 revision 只有一个原因，事务、事件和故障结果更容易审计。

### 9.4 prefix 与 measurement

同一个 `revisionId` 内继续执行当前四项检查：

- request config 不变；
- tool schema 不变；
- segment count 不缩短；
- 旧 segment boundary 的 prefix hash 不变。

提交 `surface_refresh` 时必须在同一 transaction 中删除
`context_measurement_state`。COMMIT 后：

- ContextMeter 从 `estimated_full` 重新开始；
- CommittedPrefixAuditor 为新 `revisionId` 建立 anchor；
- 后续请求继续严格 append。

如果 active surface 未变化，可以恢复 exact measured anchor。trigger ratio 等纯 policy 变化不
改变 request/prefix identity，因此允许复用相同 token anchor，再用当前阈值重新计算 pressure。

## 十、MCP 语义

### 10.1 有意增加或移除 MCP

MCP config 中 server 集合的有意变化属于 capability refresh：

- 增加 server 或工具：新 surface 包含新增 definitions；
- 移除 server 或工具：新 surface 不再向模型声明这些工具；
- description/input schema 变化：生成新 surface；
- 历史 closed assistant tool call 和 tool result 继续保存在 canonical history，不重新执行。

### 10.2 临时 MCP 故障

当前 `McpManager` 会记录 `mcp.server.failed` 后跳过 server。本方案不能沿用这一行为来生成
surface，否则一次临时故障会被提交成永久 capability removal。

activation 应区分：

- server 不再出现在当前 config：有意移除，可 refresh；
- server 仍在 config，但 connect 或 `listTools()` 失败：初始化失败，不创建 surface/revision；
- server 正常返回零 tools：有效 surface；
- duplicate tool name 或无效 schema：fast-fail。

失败消息必须指出 server name 和失败阶段，但不能输出 command env、secret 或完整 schema。

### 10.3 provider smoke gate

把 tool schema 移出 session contract 之前，必须用每个受支持 provider profile 验证：

1. session 完成一次 MCP tool-call/tool-result exchange；
2. 退出 session；
3. 从 config 移除该 MCP；
4. resume 创建 surface revision；
5. 下一次 provider request 携带历史 closed tool exchange，但当前 tools 不再声明该函数；
6. provider 接受请求并正常返回。

还要验证反向场景：历史没有该 MCP，resume 后新增工具并正常调用。

如果任一正式支持的 provider 拒绝“历史中存在、当前 definitions 中已移除”的闭合 tool
exchange，则不能直接批准完整 tool-surface refresh；届时应保留 tool schema gate，或单独设计
经过验证的 historical tool declaration 机制。不能用静默 fallback 绕过 smoke 结果。

## 十一、Observation format

### 11.1 归属每条记录

`tool_results.observation_format` 继续保存产生该 observation 时的格式，并拆分为：

```ts
const CURRENT_TOOL_OBSERVATION_FORMAT = "tool-observation-v2";

type SupportedToolObservationFormat = "tool-observation-v2";
```

具体 supported union 只包含实际能够读取的历史格式；不能为了看起来兼容而声明未实现的版本。
将来实现并启用 v3 时，再把 v3 加入 union，同时继续保留 v2 decoder。

### 11.2 schema 与 decoder

schema v6 不再用 CHECK 把 returned result 固定为某一个 literal，只要求：

- returned completion 的 `observation_format` 非空；
- synthetic completion 的 `observation_format` 为 NULL；
- application decoder 必须识别 supported format；
- 未知 format 返回明确的 session integrity/recovery error。

新增当前 format 时，不重写旧 rows；同一个 session 可以合法包含 v2 历史 observation 和 v3
新 observation。

### 11.3 不重新渲染历史 observation

resume、ContextRevision compile、Recall 和 TUI projection 都继续读取 stored tool message
content。`raw_json` 只用于审计和稳定来源，不用于用当前 ObservationBuilder 重建历史文本。

## 十二、context policy 更新语义

### 12.1 activation 时重新派生

每次 new/resume activation 都从已通过 contract 校验的 `contextProfile` 和当前产品常量派生
`ModelContextBudget`。

假设仅把 trigger ratio 从 `0.8` 改为 `0.4`，一个当前占用比例为 `0.6` 的 session：

1. compatibility contract 通过；
2. active surface 不变，不创建 revision；
3. measured anchor 若 prefix 完全相同则可以恢复；
4. ContextMeter 使用当前 ratio 把 pressure 重新分类为 `triggered`；
5. resume 正常进入 ready，不在打开过程中静默 compact；
6. 当前 I1 路径在下一次 model preflight 只执行 shadow planning；手动 `/compact` 仍是唯一
   active revision commit 入口。

若当前 usage 超过新的 hard `inputBudgetTokens`，session 仍可被打开并展示 blocked 状态；下一
turn 必须在 provider request 前被明确拒绝，用户可以在 idle 状态执行 `/compact`。自动治理
属于后续 roadmap，不在本方案中提前实现。

### 12.2 request policy 变化

如果当前产品参数改变 `requestMaxOutputTokens`，历史 messages 仍然兼容，因此不阻断 resume；
但 request fingerprint 会变化，应创建 `surface_refresh` 并清除 measured anchor。

## 十三、new session 初始化流程

ContextSurface 依赖最终 tool definitions，而当前 schema v5 在 tooling/MCP 初始化之前就创建
`initial_full` revision。schema v6 必须把 bootstrap 改成两阶段：

```text
resolve config/profile/workspace realpath
  -> load current project instructions
  -> build current system prompt
  -> create SessionStore(initialization_state=creating)
     - write session meta creation identity
     - write immutable canonical creation system frame/message
     - active_revision_id remains unset while creating
  -> create RuntimeSession staging context and required sinks
  -> initialize built-in tooling
  -> initialize configured MCP strictly
  -> build SessionCompatibilityContract
  -> prepare current ContextSurface from system prompt + final tools + request policy
  -> one finalize transaction
     - insert compatibility contract/hash
     - insert initial ContextSurface
     - insert initial_full revision referencing that surface
     - set active_revision_id
     - creating -> ready
  -> full store/revision/surface validation
  -> initial context measurement
  -> RuntimeSession ready
```

schema v6 允许 `creating` meta 暂时没有 active revision，但 `ready` 必须同时拥有：

- valid compatibility contract；
- exactly one initial surface；
- exactly one initial revision；
- active revision 指向 revision 1。

初始化失败继续使用现有窄 rollback：只删除本次未 ready、没有 turn、仅含已知文件的 session；
不增加递归强制删除或不确定 fallback。

## 十四、resume 流程

恢复顺序固定为：

```text
resolve current config/profile/workspace realpath
  -> open and validate ready schema v6 store
  -> validate creation system frame and canonical history
  -> build current SessionCompatibilityContract
  -> exact compatibility assertion
  -> load current project instructions and build current system prompt
  -> initialize current built-in tooling and configured MCP strictly in staging
  -> prepare candidate ContextSurface
  -> recover interrupted open canonical frame, if any
  -> reload closed canonical snapshot
  -> compare candidate surface with active stored surface
     - equal: reuse active revision
     - changed: atomically commit surface_refresh revision
  -> initialize ledger/context manager
  -> restore exact measured anchor only when active revision and full fingerprint match
  -> mark resumed and emit bounded refresh summary
  -> RuntimeSession ready
```

compatibility assertion 必须发生在 canonical recovery mutation 之前。MCP 和 project-instruction
初始化也应在 staging 中完成；失败时不能提交 surface refresh。初始化诊断事件可以在 ready
后按分配好的 event sequence 刷出，不能要求为了记录失败而先改变 canonical history。

### 14.1 surface equality

surface 比较使用 canonical manifest 和 hash，至少检查：

```text
systemPromptSha256
projectInstruction manifest
toolDefinitionsSha256
toolSchemaSha256
requestConfigSha256
requestMaxOutputTokens
surfaceSha256
```

只改变 API base URL、API key、timeout 或 trigger ratio 时，surface 必须保持相同。

### 14.2 user-visible refresh

surface refresh 不能静默。`session.resumed` 或独立事件应提供人类可读摘要，例如：

```text
Runtime context refreshed on resume: project instructions, MCP tools.
```

允许显示：

- changed component names；
- previous/current revision number；
- tool count before/after；
- project instruction file name。

禁止显示：

- prompt 或 AGENTS.md 正文；
- tool schema 正文；
- API endpoint、key、MCP command/env；
- 内部 hash，除非明确 diagnostic surface 请求。

## 十五、schema v6

### 15.1 `session_meta`

`session_meta` 调整如下：

- 保留 creation `system_prompt_sha256` 和 creation project-instruction manifest；
- `runtime_contract_json/hash` 重命名为
  `session_compatibility_json/hash`；
- 删除 session-wide `tool_schema_sha256`；
- `active_revision_id` 在 `creating` 时允许 NULL，在 `ready` 时必须非 NULL；
- ready 后 compatibility、creation identity 和 active chain 继续不可回写。

### 15.2 `context_surfaces`

新增 immutable table，保存第八节定义的 surface。至少约束：

- surface/session identity；
- system prompt 非空且 hash 匹配；
- tool definitions 是 valid canonical JSON；
- 所有 hashes 长度正确；
- request output limit 是 positive safe integer；
- surface row 不可 update/delete。

### 15.3 `context_revisions`

新增 `surface_id/surface_sha256`，允许 `surface_refresh`：

- initial revision 引用本 session 的 initial surface；
- swap revision 的 surface 必须等于 parent；
- surface refresh 的 surface 必须属于本 session 且不同于 parent；
- surface refresh 不新增 override，累计 override manifest 与 parent 相同；
- active ID 只允许原子前进到直接 child；
- revision、surface 和 overrides 都不可 update/delete。

### 15.4 `tool_results`

移除固定 `observation_format = 'tool-observation-v2'` 的 CHECK，保留 returned/synthetic 的 NULL
关系约束。supported format 由 application decoder fast-fail 校验。

### 15.5 cutover

本方案采用一次性 cutover：

```text
SESSION_SCHEMA_VERSION = 6
v5 -> SESSION_SCHEMA_UNSUPPORTED
no migration
no dual read/write
no reconstruction fallback
```

原因是 surface table、revision shape、initialization lifecycle 和 contract columns 都发生结构性
变化。若必须保留某些 v5 session，应另行设计离线、显式、一次性验证的 import 工具，不进入
runtime resume path。

## 十六、事务、失败与恢复

### 16.1 surface refresh transaction

提交必须在一个 `BEGIN IMMEDIATE` transaction 中完成：

1. 重新读取 active revision/surface 和 closed canonical tail；
2. 验证 expected base revision、surface、override manifest 和 canonical boundary；
3. 重新 compile prospective messages + surface；
4. 验证完整 prepared request fingerprint；
5. insert immutable surface；
6. insert `surface_refresh` revision；
7. delete measured context anchor；
8. update `active_revision_id`；
9. read back 并 full validate；
10. COMMIT。

事务前失败不写 durable state；事务中失败完整 rollback，旧 active revision 继续有效。COMMIT 后
即使 event/TUI reporting 或 runtime activation 失败，也不能补偿性切回旧 revision；下次 resume
必须把已提交的新 revision 当作 source of truth。

### 16.2 idle boundary

surface refresh 只允许在没有 open turn、iteration 或 frame 的 idle boundary 提交。resume 有
interrupted tail 时先执行现有 synthetic recovery，再以恢复后的 closed tail 创建 revision。

### 16.3 MCP failure

configured MCP failure 发生在 surface transaction 前。它关闭已创建 connections、释放 store
lease，并报告明确错误；不得提交缺少该 MCP 的 surface。

### 16.4 project instruction failure

当前 AGENTS.md 存在但无效、不可读、超限或越界链接时，resume fast-fail；不能继续使用旧
project instruction，也不能回退 CLAUDE.md。该语义与新 session 的 loader 规则一致。

## 十七、事件与可观察性

扩展现有 context revision events，使 strategy 成为判别联合：

```ts
type ContextRevisionStartedData =
  | {
      strategy: "swap";
      reason: "manual";
      // existing fields
    }
  | {
      strategy: "surface_refresh";
      reason: "resume";
      changed: readonly ContextSurfaceComponent[];
    };
```

finished event 至少记录：

- base/new revision number；
- changed component names；
- tool count before/after；
- whether measured anchor was cleared；
- bounded duration。

failed event 记录 `stage` 和稳定 error code，不记录正文或 secret。TUI 可以把成功 refresh 作为
一次 notice，而不是混入历史 assistant/tool timeline。

## 十八、测试与验证门禁

### 18.1 compatibility contract

- model name 变化拒绝；
- profile name 变化拒绝；
- reasoning replay 变化拒绝；
- context profile 任一字段变化拒绝；
- message adapter/serialization version 变化拒绝；
- API base URL/API key/timeout 变化允许；
- trigger ratio、trigger tokens、max iterations 变化允许；
- contract 不含 generic version、system prompt、tool schema、derived budget 或 observation format。

### 18.2 system/project instructions

- AGENTS.md 修改后 resume 创建一条 surface revision；
- resumed provider request 使用新正文；
- canonical creation system message 和 creation manifest byte-stable；
- 当前 prompt 未变化时不创建空 revision；
- AGENTS.md 新增、删除以及 AGENTS -> CLAUDE fallback 都有确定 refresh；
- 无效当前 instruction fast-fail，不继续使用旧副本；
- runtime instructions 代码变化可通过注入 fixture 触发同样 refresh。

### 18.3 MCP/tool surface

- 增加 MCP tool 创建 surface revision；
- 移除 MCP tool 创建 surface revision；
- description/input schema 变化创建 revision；
- MCP 返回顺序变化但 final definitions 相同，不创建 revision；
- timeout/observation limit 变化不创建 revision；
- configured server connect/listTools 失败 fast-fail，不提交 reduced surface；
- duplicate final tool name fast-fail；
- provider smoke 覆盖历史 closed tool exchange + 当前已移除 definition。

### 18.4 observation formats

- 同一个 session 中旧 format 和 current format 可以共同恢复；
- 历史 observation content/hash 不变；
- resume 不调用 ObservationBuilder 重建历史；
- unknown format 明确 fast-fail；
- synthetic results 继续没有 observation format。

### 18.5 context policy

- ratio `0.8 -> 0.4` 不阻断 resume；
- usage `0.6` 被当前 policy 分类为 triggered；
- resume 本身不自动 commit compact revision；
- blocked session 可以进入 TUI，但下一 provider request 前被拒绝；
- 当前 `/compact` 使用新 budget/policy 正常工作；
- request max output 变化创建 surface revision 并清除 anchor。

### 18.6 revision 与事务

- surface refresh 继承全部 active swap overrides；
- swap revision 继承 active surface；
- refresh 不改变 canonical/Recall/FTS；
- same revision 继续拒绝非 append prefix；
- refresh revision 首次 measurement 是 `estimated_full`；
- unchanged surface 可以 exact restore measured anchor；
- 每个 transaction 注入点验证完整 rollback；
- COMMIT 后 activation/event 失败仍以新 revision 为 source of truth；
- resume 后 revision chain 线性、连续且 active 始终是 latest。

### 18.7 总门禁

实施完成至少运行：

```bash
bun run check
git diff --check
```

另需运行：

- focused session resume tests；
- schema/transaction fault-injection tests；
- current manual `/compact` regression；
- MCP add/remove provider smoke；
- system prompt refresh real TUI smoke；
- context benchmark，确认 unchanged revision 的 append/cache 行为没有退化。

surface refresh 必然使 provider prefix cache 在 revision boundary 至少部分 miss；该成本应记录，
但不能以保留过时 system prompt 为代价规避。

## 十九、实施顺序

1. 把 model message protocol identity 和 request fingerprint 拆开，补纯单元测试。
2. 定义 `SessionCompatibilityContract`，删除不属于兼容边界的字段和旧消费者。
3. 设计并落地 schema v6：两阶段 initialization、context surfaces、revision 扩展和 per-record
   observation format。
4. 扩展 ContextRevisionCompiler/ContextBuilder，使 active surface 成为唯一模型输入来源。
5. 实现 `commitSurfaceRefresh()` 的完整 prospective validation 和原子 transaction。
6. 调整 new/resume bootstrap 顺序，恢复时加载当前 project instructions。
7. 调整 MCP staging/strict failure 和 deterministic tool ordering。
8. 更新 ContextMeter anchor、SwapPlanner/ContextManager base validation 和 ResumeProjectionReader。
9. 增加 bounded events/TUI notice。
10. 完成测试、provider smoke、benchmark 和相关 docs 状态更新。

不要先只删除 contract 字段再补 revision。那会让 resume 在没有 durable surface 记录的情况下
接受变化，破坏 byte-stable recovery 和故障审计。
