# `/fork` Session Clone 技术方案

## 文档状态

- 日期：2026-07-19
- 状态：已实施并验证
- 当前基线：SessionStore schema v8、`/resume`、`ResumeProjectionReader`、
  `DefaultTuiSessionController`
- 相关设计：
  [`session-store-resume-design.md`](session-store-resume-design.md)、
  [`runtime-contract-context-surface-refresh-design.md`](runtime-contract-context-surface-refresh-design.md)、
  [`stable-source-recall-design.md`](stable-source-recall-design.md)

## 一、结论

Tinker 的 `/fork` 定义为：在当前 session 空闲且 canonical tail 已闭合时，clone
完整 session directory，给 clone 分配新的 `sessionId`，校验并发布后，使用现有
resume activation 打开 clone，最后把 TUI 切换到 clone。

这里的 `fork` 只是用户命令名称。存储语义是 clone，不引入 parent、child、branch、
lineage 或 merge：

- 原 session 不记录 clone 的存在；
- clone 不记录原 session 的存在；
- 两者从 clone 发布后完全独立；
- 原 session 仍可通过现有 `/resume` 找回；
- clone 不产生 provider request，不执行工具，也不重放历史副作用。

本阶段保持 SessionStore schema v8，不增加字段、表或兼容分支，不升级 schema version。

## 二、用户语义

### 2.1 命令

本阶段只支持：

```text
/fork
```

执行成功后：

1. Tinker 生成一个新的 session UUIDv7；
2. clone 当前完整 session 状态；
3. 通过现有 resume activation 打开 clone；
4. TUI 显示与当前 session 相同的历史 timeline；
5. 后续输入只追加到 clone；
6. 原 session 保持独立并继续出现在 `/resume` 中。

成功提示使用：

```text
Cloned current session as <new-session-id>. Previous session remains available via /resume.
```

提示不包含原 session ID，也不把两个 session 描述为父子关系。

### 2.2 可用边界

`/fork` 只允许在 `RuntimeSession.canSwitchSession()` 为 `true` 时执行，即：

- runtime state 为 `ready`；
- 没有 active turn；
- 没有正在执行的 context operation；
- 没有 `running` 或 `stopping` 的后台任务。

不在运行中 snapshot turn，不合成 interrupted turn，不停止后台任务来强行 clone。条件不满足时
立即给出明确错误，当前 session 保持不变。

### 2.3 clone 后的等价性

在 clone 完成、resume activation 尚未因当前 runtime surface 产生合法 refresh 之前：

- canonical frames、messages、tool results 完全相同；
- active context revision 的模型可见内容完全相同；
- Recall 对共同历史返回相同内容；
- turn、iteration、tool call 和 event 的 next counter 保持连续；
- measured anchor 继续由现有 exact-match 规则决定是否可用。

clone 不表示两个 session 此后保持同步。任意一边的新 turn、compact、retire、Skills 更新或
surface refresh 都只作用于各自数据库。

## 三、为什么是完整 SessionStore clone

Tinker 的可继续状态不只在 `messages` 中。schema v8 还持久化：

- `turns`、`iterations`、`protocol_frames`；
- `tool_results`；
- `context_surfaces`；
- 完整线性的 `context_revisions`；
- `context_overrides`；
- `skill_activations`；
- `context_measurement_state`；
- Recall FTS index。

只复制 messages 再创建新的 initial revision 会改变 compact、prefix retirement、
surface refresh 或 Skills activation 后的真实模型上下文。因此 `/fork` 的最小正确复制单位是
完整 SessionStore snapshot，而不是聊天文本、TUI timeline 或 event log。

`events.jsonl` 和 `observations.md` 一起 clone，但继续只属于诊断面；它们永远不是
canonical recovery input。

## 四、必须保持的不变量

```text
schema version remains 8
schema fingerprint remains SESSION_SCHEMA_V8_FINGERPRINT
source and clone use different sessionId values
source database is never mutated by clone construction
clone contains no source-session reference
clone is invisible to SessionCatalog until every artifact is complete
all canonical rows in clone use the clone sessionId
historical non-session IDs remain unchanged
canonical model-visible content remains unchanged
all session-scoped integrity hashes validate under the clone sessionId
Recall index is preserved with the SQLite snapshot and verified against cloned canonical messages
events.jsonl contains only the clone sessionId at the event-envelope level
observations.md is rendered from the cloned event stream
no provider request or tool execution occurs during clone construction
existing resume activation is the only activation path for the published clone
```

## 五、clone directory 与原子发布

### 5.1 目录内容

成功发布的 clone 目录为：

```text
.tinker/sessions/<new-session-id>/
  session.sqlite
  events.jsonl
  observations.md
```

SQLite 是必需 artifact。诊断文件按第七节规则生成；生产 session 正常情况下两者都存在。
`active.lock`、`active.lock.reclaim`、SQLite WAL/SHM 和任何运行中进程状态都不复制。

### 5.2 staging directory

clone 先构建在：

```text
.tinker/sessions/.cloning-<random-uuid>/
```

staging 名称不是合法 `SessionId`，因此现有 `SessionCatalog` 会忽略它。目录权限为 `0700`，
其中普通文件权限为 `0600`。

发布顺序：

1. 创建 staging directory；
2. 构建并校验 `session.sqlite`；
3. 重写 `events.jsonl`；
4. 从重写后的 events 生成 `observations.md`；
5. 校验文件类型、权限、event sequence 与目标身份；
6. 将 staging directory 原子 rename 为 `<new-session-id>`；
7. 使用现有 `openStoredSession(newSessionId)` 打开 clone。

最终目录若已存在，立即失败，不覆盖、不合并。任一步失败都清理 staging；若最终目录尚未发布，
`/resume` 不得看到半成品。

文件系统无法把 SQLite transaction 与两个普通文件放在同一事务中，因此 staging directory
加最终 rename 是 session-directory 级的 publication boundary。

## 六、SQLite clone 与身份重键

### 6.1 所有权与一致性边界

新增存储入口建议命名为：

```ts
SessionStore.cloneTo({
  targetSessionId,
}): Promise<void>
```

它只能由当前持有源 `SessionLease` 的 `SessionStore` 调用。不能通过
`SessionStore.openExisting(sourceSessionId)` 再获取第二份 source lease。

调用前必须：

1. 循环等待 runtime `eventTail`，直到 await 前后 tail 引用不再变化；
2. 再次确认 `canSwitchSession()`；
3. `validateAll({allowOpenTail: false})`；
4. 确认没有 open turn、iteration 或 protocol frame；
5. 通过第 6.2 节的 `VACUUM INTO` 在 source connection 上取得一致性 snapshot。

clone 期间 controller 串行化 session operation，不能同时开始 turn、compact、retire、resume、
model switch、clear、delete 或第二次 fork。

### 6.2 复制方式

不要用普通 `copyFile(session.sqlite, ...)`。源数据库使用 WAL，单独复制 main database 文件
不能保证包含最新 committed pages。

实现使用持有 source lease 的同一 `SessionStore` connection 执行参数化
`VACUUM INTO ?`，直接输出 staging `session.sqlite`。`VACUUM INTO` 由 SQLite 在 source
connection 上取得一致性 snapshot，包含已经提交到 WAL 的最新状态，并完整复制 tables、
indexes、views、triggers、FTS shadow tables、rowid、application ID 与 user version。目标文件
必须事先不存在；该操作不放在 source transaction 内，也不改变 source database。

采用这条路径还有一个结构性原因：当前 schema 存在外键环：

```text
turns.final_message_id -> messages.message_id
messages.turn_id       -> turns.turn_id
```

因此在 `foreign_keys = ON` 时不存在可以靠拓扑排序得到的“外键安全逐表导入顺序”。逻辑导入
若要成立，仍必须使用 deferred foreign keys 或先写 NULL 再回填，反而增加字段遗漏和中间状态
故障面。`VACUUM INTO` 避免重建 rows，不需要解决 insert ordering。

staging SQLite 创建后按以下步骤重键：

1. 使用生产 writable-database 配置打开 staging database；
2. 先执行 `verifySessionSchema(staging, sourceSessionId)`，确认 snapshot 完整且仍是精确 v8；
3. 由 `session-schema.ts` 中受控的内部 helper 暂时 drop 所有会阻止 identity update 的
   immutable/monotonic triggers；
4. 开启一个 target transaction，并启用 `PRAGMA defer_foreign_keys = ON`；
5. 更新所有 session-scoped rows 的 `session_id`，同时重算 session-scoped revision hashes；
6. 在 commit 前执行 `PRAGMA foreign_key_check`，确认 deferred foreign-key state 最终闭合，
   再提交 transaction；
7. 使用 schema module 保存的精确 v8 SQL 原样重建被 drop 的 triggers；
8. 依次执行 `verifySessionSchema(staging, targetSessionId)`、`verifySqliteIntegrity()`、
   `verifyRecallIndex()` 和完整 `SessionStore.validateAll({allowOpenTail: false})`；
9. checkpoint/close staging database，只发布 standalone `session.sqlite`，不携带 source WAL/SHM。

trigger drop/recreate 只能发生在未发布、没有 lease consumer 的 staging database。helper 必须从
当前 `schemaDefinitions` 的正式 trigger 定义生成精确名称和 SQL，不能手写第二份 trigger schema，
也不能暴露为普通 SessionStore mutation API。`verifySessionSchema()` 的全文 schema 比对是
trigger 恢复的发布门禁：少一个 trigger、SQL 有任何 drift 或出现额外对象都必须失败。

`VACUUM INTO` 会保留 `messages` 的 rowid 和 content，因此 external-content FTS 与 canonical
messages 的映射不因 session identity re-key 而改变。本阶段不无条件 rebuild FTS；发布前仍必须
执行 `verifyRecallIndex()`，任何不一致都 fast-fail，不能带损坏 index 发布。

### 6.3 session identity 重键

目标数据库中的以下 `session_id` 全部替换为 `targetSessionId`：

- `session_meta.session_id`；
- `turns.session_id`；
- `iterations.session_id`；
- `protocol_frames.session_id`；
- `messages.session_id`；
- `tool_results.session_id`；
- `context_surfaces.session_id`；
- `context_revisions.session_id`；
- `context_overrides.session_id`；
- `skill_activations.session_id`；
- `context_measurement_state.session_id`。

除 session identity 外，历史内部 ID 保持不变：

- turn、iteration、frame、message、tool-call ID；
- provider tool-call ID；
- surface、revision ID；
- override 与 Skill activation 引用。

这些 ID 位于两个独立 SessionStore namespace 中。保留它们可以避免重写 tool-call protocol、
override targets、Skill settlement 和 `ctx://message/<message-id>`；clone 发布后的新增记录继续
使用新的 UUIDv7。

### 6.4 session-scoped hash 重算

`canonicalSequenceHash()` 当前把 `canonical.sessionId` 放入 hash。仅替换数据库列中的
`session_id` 会使每个 stored context revision 无法通过 compiler 校验。

因此 clone 必须针对每一条 `context_revisions`，使用 target `sessionId` 和该 revision 的
`source_through_ordinal` 重新计算：

```text
canonical_sequence_sha256
```

这只是 identity re-key，不改变 frames、messages、ordinals、content hashes 或模型可见内容。

不得为了简化 clone 而从 `canonicalSequenceHash()` 删除 session identity。那会改变所有现有
v8 revision hash 的语义，反而形成未版本化的协议变化。

其他 hash 是否重算由其正式输入决定，不按字段名猜测。实现应逐一验证 active revision、
historical revision chain、surface、override manifest、rendered message 与 measured anchor；
只有输入包含 session identity 的 hash 才重算。当前 `surfaceSha256` 不包含 `sessionId`，因此
只改变 `context_surfaces.session_id`，保留 surface identity 与 hash。

### 6.5 metadata 与 counters

clone 复制 source 的：

- compatibility contract；
- active revision；
- next turn number；
- next event sequence；
- open count 与历史 timestamps；
- creation prompt/project-instruction metadata；
- last close metadata；
- measured anchor。

随后现有 resume activation 会：

- 做 compatibility fast-fail；
- 按现有规则处理 interrupted recovery（正常 clone 应无 open state）；
- 把 `open_count` 增加一次；
- append `session.resumed`；
- exact-match 恢复 measured anchor；
- 必要时通过合法 revision 刷新当前 AGENTS.md、MCP 或 Skills surface。

clone construction 本身不伪造新的 `session.started`，也不引入 `session.forked` event。

## 七、诊断文件 clone

### 7.1 `events.jsonl`

`events.jsonl` 中每一行 `AgentEvent` envelope 都包含 `sessionId`。不能直接逐字节复制，否则
历史行使用 source ID，而 clone runtime 追加的行使用 target ID。

clone 必须逐行：

1. 以 UTF-8 读取；
2. JSON parse；
3. 校验为支持的 `AgentEvent` envelope；
4. 确认顶层 `sessionId` 等于 source session ID；
5. 只把顶层 `sessionId` 改为 target session ID；
6. JSON serialize 到 staging `events.jsonl`。

以下内容原样保留：

- `eventSequence`；
- timestamp；
- turn/iteration/tool-call identity；
- event type 与 data；
- prompt、assistant progress、tool output 和错误文本。

禁止对原始 JSON 文本做全局字符串替换。用户输入或工具输出可能恰好包含 source UUID；这些
内容不是 event-envelope identity，不应修改。

重写后验证：

- 所有 envelope 都只含 target session ID；
- event sequence 严格递增，允许已有空洞但不允许重复或倒退；
- 最大已写 sequence 小于 target `session_meta.next_event_sequence`；
- 文件是 owner-only regular file。

若源 `events.jsonl` 不存在，诊断历史不阻断 canonical clone：目标暂不创建 events 与
observations，首次 resume event 由现有 sinks 创建两个文件。若源文件存在但不是安全 regular
file、不是合法 UTF-8、含 malformed JSON 或 identity/sequence 不合法，则明确失败，不静默
丢行或复制损坏日志。

### 7.2 `renderObservationLogEvent()`

把 `observation-text-log.ts` 当前私有 renderer 提取为共享纯函数：

```ts
export function renderObservationLogEvent(
  event: AgentEvent,
): string | undefined;
```

`ObservationTextLog.append()` 调用该函数；clone 也调用同一个函数。不要建立第二套 Markdown
renderer。

### 7.3 `observations.md`

`observations.md` 不直接复制，也不做全文 UUID replacement。clone 从已经重写 target
sessionId 的 event stream 逐条调用 `renderObservationLogEvent()`，按原顺序生成新的文件。

这样可保证：

- `# Tinker Session ...` 使用 target session ID；
- turn、iteration、call ID 与 cloned canonical history 一致；
- 只投影 renderer 正式支持的 events；
- clone 发布后的实时 append 使用同一格式。

若 renderer 从 source 日志写入后发生过变化，目标 `observations.md` 允许与源文件不满足
byte-for-byte equality；它必须满足“同一 cloned event stream 在当前 renderer 下的确定性
投影”。这不影响 SQLite canonical truth。

## 八、Runtime 与 TUI 接线

### 8.1 RuntimeSession

在 runner-facing `RuntimeSession` 增加受控入口：

```ts
cloneSession(targetSessionId: SessionId): Promise<void>;
```

该入口：

1. fast-fail 检查 session 可切换；
2. 循环等待 required event sinks 到稳定的 event tail；
3. 调用 `SessionStore.cloneTo()`；
4. 不关闭 source runtime；
5. 不自行打开 clone。

这里不能只捕获并 await 一次 `this.eventTail`。当前 `append()` 在 sink 返回 diagnostics 时会
通过 `void this.append({type: "diagnostic.sink_failed", ...})` 追加新 event，而这次内部 append
会在旧 tail 尚未完成时替换 `this.eventTail`。单次 await 可能在新 diagnostic event 写完前开始
复制 `events.jsonl`。

RuntimeSession 应提供私有稳定等待：

```ts
private async waitForStableEventTail(): Promise<void> {
  for (;;) {
    const tail = this.eventTail;
    await tail;
    if (this.eventTail === tail) return;
  }
}
```

每次 `append()` 都会同步替换 tail 引用，所以循环直到引用稳定可以覆盖 sink callback 内新挂上的
diagnostic events。等待完成后必须再次检查 `canSwitchSession()`；若 event append 已使 runtime
进入 `faulted`，clone 立即失败。controller 的 session-operation serialization 和第二次 idle
检查共同保证随后不会有普通 turn/context operation 开始写 event。

source runtime 是否 dispose 继续由 `DefaultTuiSessionController` 的 target-first switch
流程负责。

### 8.2 TuiSessionController

增加：

```ts
fork(): Promise<SessionId>;
```

controller 在现有 serialized session operation 中执行：

```text
current binding
  -> allocate target sessionId
  -> current.runtimeSession.cloneSession(target)
  -> openStoredSession(target) through existing resume activation
  -> hydrate target with ResumeProjectionReader
  -> dispose current with session_switch
  -> replace binding
  -> notify subscribers
```

必须保持 target-first：

- clone 构建或 target activation 失败时，当前 binding 继续可用；
- current dispose 只在 target runtime 和 projection 都成功后发生；
- current dispose 失败时，按现有 replace-session 失败路径关闭 target runtime，不把 TUI
  留在两个 active writer 之间。

clone 已发布但后续 activation 失败时，该 clone 是结构完整的可恢复 session。controller 应
关闭其 lease；是否保留最终 clone 供稍后 `/resume`，沿用现有 target-first session-switch
失败策略，不把已发布的完整 session 当作 initialization garbage 删除。

### 8.3 Slash command 与 App

`src/tui/slash-commands.ts` 增加：

```ts
{ name: "fork", description: "Clone the current session" }
```

parser 只接受无参数 `/fork`。`App` 使用现有 `isSessionOperation` 屏障调用
`sessionController.fork()`，成功后刷新 header、timeline、Git branch 与 notice；失败时显示
有界错误，不把命令提交给模型。

本阶段不新增 picker、确认弹窗、branch tree 或 lineage 展示。

## 九、失败语义

### 9.1 publication 前失败

以下任一步失败都删除 staging，保持当前 session 和 binding 不变：

- source idle/closed-tail 校验；
- source read snapshot；
- `VACUUM INTO` snapshot 或 staging re-key；
- session identity re-key；
- revision hash 重算；
- Recall integrity verification；
- event rewrite；
- observation projection；
- permission/integrity 校验；
- final rename 前的目标冲突检查。

不得保留合法 UUID 命名的半成品目录。

### 9.2 publication 后失败

final rename 成功后，clone 已是独立、完整、可 resume 的 session。之后若：

- 当前 MCP server 无法连接；
- compatibility mismatch；
- current surface refresh 失败；
- projection hydration 失败；
- source dispose 失败；

则按现有 resume/target-first 规则明确报错。不能回写或删除 source canonical history，也不能
假装 clone 未发布。

### 9.3 不允许的 fallback

不允许：

- SQLite clone 失败后只复制 timeline；
- event rewrite 失败后混合 source/target session ID；
- observation rebuild 失败后复制旧 header；
- Recall integrity verification 失败后带损坏 index 发布；
- revision hash 不匹配时创建一个猜测性的 initial revision；
- source lock 冲突时绕过 lease；
- clone 失败时自动执行 `/clear`。

## 十、代码落点

预计修改：

- `docs/session-fork-design.md`：本方案；
- `src/session/session-schema.ts`：受控的 clone trigger drop/reinstall helper，复用正式 v8
  definitions，不改变 fingerprint；
- `src/session/session-store.ts`：`VACUUM INTO` snapshot、`cloneTo()`、deferred-FK identity
  re-key、revision hash 重算与 staging publication；
- `src/events/observation-text-log.ts`：导出并复用 `renderObservationLogEvent()`；
- `src/agent/runtime-session.ts`：受控 `cloneSession()` 与 event-tail/idle 屏障；
- `src/tui/tui-session-controller.ts`：serialized target-first `fork()`；
- `src/cli/tui-runner.tsx`：复用 `openStoredSession()` 打开 clone；
- `src/tui/slash-commands.ts`：注册和解析 `/fork`；
- `src/tui/app.tsx`：命令执行、notice 与 binding refresh；
- `src/__tests__/`：存储、runtime、controller、projection、slash command 与 TUI 测试。

不要引入 fork 专用 history renderer、fork 专用 resume path 或第二个 SessionStore owner。

## 十一、测试与验证

### 11.1 SessionStore clone

- completed text-only session clone 后 full protocol view 等价；
- tool-call session clone 后 assistant/tool protocol 与 raw result 等价；
- source 与 target session ID 不同，所有 target session-scoped rows 一致；
- historical internal IDs 保留；
- next counters 连续；
- source database 在成功和失败路径都不变；
- source 有 open turn/frame 时 fast-fail；
- schema application ID、user version、fingerprint 保持 v8；
- quick check、foreign-key check、full protocol validation 全部通过；
- `VACUUM INTO` 保留全部 v8 schema objects、message rowid 与 FTS shadow state；
- trigger drop/reinstall 后 `verifySessionSchema()` 全文比对通过；
- deferred foreign keys 正确处理 `turns.final_message_id` 与 `messages.turn_id` 的引用环。

### 11.2 Context 与 Recall

- initial revision clone；
- swap-only compact 后 clone；
- prefix retirement 后 clone；
- surface refresh 后 clone；
- Skills update/override 后 clone；
- 每条 historical revision 的 canonical sequence hash 在 target identity 下有效；
- active compiled provider-neutral messages 在 clone 前后相同；
- measured anchor 在完全相同 request 下 exact restore；
- activation 产生 surface change 时 anchor 按现有规则清除；
- RecallGet/search 在 source 与 clone 中返回相同共同历史；
- clone 任何一边追加新消息后，另一边 Recall 不可见该消息。

### 11.3 诊断文件

- events 每行只修改顶层 session ID；
- prompt/tool output 内出现 source UUID 时正文不变；
- sequence、timestamp 和 identity 保留；
- event sequence 与 target SQLite next counter 一致；
- observations 从共享 renderer 重建；
- observations header 使用 target session ID；
- source events 缺失时 canonical clone 仍成功，resume append 创建新日志；
- malformed、混合身份或倒退 sequence 的 source events 明确失败；
- staging 或最终 artifact 权限不安全时失败。

### 11.4 Controller 与 TUI

- `/fork` 不进入 agent loop；
- 运行中 turn、compact 或后台任务期间拒绝；
- target-first：clone/open/hydrate 失败时当前 binding 不变；
- 成功后 header 使用新 session ID，timeline 与 source 等价；
- clone 中执行新 turn 后 `/resume` source，不出现 clone-only 内容；
- 再 resume clone，clone-only 内容仍存在；
- `/fork extra` 显示 usage error；
- session operation 并发时明确拒绝；
- sink callback 在旧 tail 内追加 diagnostic event 时，clone 等待新 tail 完成且日志不漏行。

### 11.5 故障注入

在以下阶段逐点抛错并验证 source 不变、无可见半成品：

- staging mkdir；
- `VACUUM INTO` snapshot；
- trigger drop；
- deferred-FK identity update；
- trigger reinstall；
- revision hash rewrite；
- Recall integrity verification；
- event parse/write；
- observation render/write；
- chmod/validation；
- final rename；
- clone publication 后的 resume activation；
- source dispose。

### 11.6 门禁

至少执行：

```text
bun run check
bun run bench:recall
bun run bench:long-session
git diff --check
```

另做一次真实 PTY smoke：

```text
建立含工具调用的 session
  -> /compact 或 /compact retire
  -> /fork
  -> clone 中继续一轮
  -> /resume 原 session
  -> 验证原 session 无 clone-only 内容
  -> /resume clone
  -> 验证 clone-only 内容存在
```

### 11.7 2026-07-19 实施验证记录

门禁结果：

- `bun run check`：通过，`627 pass / 0 fail`；
- `bun run bench:recall`：通过；
- `bun run bench:long-session`：通过；
- `git diff --check`：通过。

真实 PTY smoke：

1. 创建 source session `019f78f8-1d04-73eb-8885-ef58cb0cf463`；
2. 要求模型调用 Bash 执行 `printf 'fork-smoke-tool-output\n'`，工具以 exit 0
   返回，assistant 回复 `TOOL_DONE`；
3. 执行 `/compact`，结果为已低于 compact target，命令没有产生 provider request；
4. 执行 `/fork`，得到 clone session
   `019f78f9-5f62-73ad-bc4e-b72336c29018`；clone 首次打开时完整显示共同的 prompt、
   Bash call/result 和 `TOOL_DONE`；
5. 在 clone 中追加一轮并得到 `CLONE_ONLY`；
6. `/resume` source，timeline 不含 `CLONE_ONLY`，追加一轮并得到 `SOURCE_ONLY`；
7. `/resume` clone，timeline 含 `CLONE_ONLY` 且不含 `SOURCE_ONLY`；
8. 退出后直接检查两个 SQLite store：两边各有 `2` 个 turn、`1` 个 tool result，
   source 只持有 `SOURCE_ONLY`，clone 只持有 `CLONE_ONLY`。验证用 session 随后已清理。

## 十二、非目标

本阶段不实现：

- `/fork <session-id>`；
- fork 到指定历史 turn；
- active turn snapshot 或 synthetic interruption；
- parent/child lineage；
- branch tree、rename、merge、diff 或同步；
- 跨 workspace clone；
- clone 后自动提交 prompt；
- SQLite hardlink、reflink 或平台相关 copy-on-write；
- 从 events、observations 或 Bash log 重建 canonical SQLite；
- schema migration、dual-read 或兼容 fallback。

如果未来需要 fork 到历史 turn，应单独设计 closed-turn prefix selection、canonical truncation、
revision rebase、override/Skills 引用裁剪和 measured-anchor 失效规则，不能在本阶段通过删除尾部
rows 顺手实现。

## 十三、实施顺序

1. 提取并测试 `renderObservationLogEvent()`，保证实时 writer 行为不变；
2. 实现 staging directory 与诊断文件 rewrite/rebuild helper；
3. 实现 `VACUUM INTO` snapshot、受控 trigger drop/reinstall 与 `SessionStore.cloneTo()`；
4. 完成 deferred-FK session identity re-key、revision hash 重算和全量校验；
5. 在 `RuntimeSession` 增加 idle/event-tail clone boundary；
6. 在 controller 中复用 `openStoredSession()` 完成 target-first switch；
7. 接入 `/fork` 和 TUI notice；
8. 完成 fault injection、完整门禁和真实 PTY smoke。

每一步都保持 `/resume`、SessionStore canonical ownership 和现有 schema v8 行为不变；不在
clone path 引入 silent fallback。
