# 让 Recall 可以选择 session

## 状态与目标

> 最新更新：自动维护已与评测彻底解耦，原 continuity v1/v2 仅为下文历史实施记录。
> 当前产品默认开启 swap / retirement，不绑定评测结果或工具描述哈希。详见
> [解耦方案](context-automation-evaluation-decoupling.md)。

- 状态：已实施（2026-09-05）；真实模型重新评测未通过主动 Recall qualification，
  按用户后续明确决定，本次 Recall 改进保留自动 swap 与自动 prefix retirement 开启，
  不变更其触发条件和执行逻辑；真实评测结果单独保留，不标为通过。
- 代码基线：Tinker `2.8.0`，commit `57bcfe2`。
- 目标：为 `RecallSearch`、`RecallGet` 增加可选的 `sessionId`，不传时保持当前行为，
  指定时读取目标 session 的历史。

这是现有 Recall 的能力扩展，不新增工具、不依赖 memoryId、不建设新的记忆溯源系统。
Memory 提供历史线索，Recall 读取历史原文；用户直接给出的 session ID 也能使用。

## 一、接口与使用方式

```ts
RecallSearch({
  query: "此前决定的配置格式",
  sessionId: "目标 session UUID", // 可选，不传时读取当前 session
  // 其他搜索、过滤和分页参数不变
})

RecallGet({
  source: "ctx://message/消息 UUID",
  sessionId: "目标 session UUID", // 可选，不传时读取当前 session
  // byte_offset、byte_limit 不变
})
```

具体规则：

- 参数名使用 `sessionId`。
- “默认空”指参数未提供；不接受 `null`、空字符串或空白字符串，避免无效目标静默回落。
- 提供时按现有 session UUID 规则解析；非法值返回参数错误。
- 不传，或显式传当前 session ID：复用当前 reader，不重新打开当前数据库。
- 指定其他 ID：定位目标 session，只读打开后执行相同的 Search/Get。
- 指定目标找不到或不可读时明确报错，绝不回退到当前 session。
- `ctx://message/<UUID>` 格式不变，不在 URI 中增加 workspace/session 字段。
- Get 的 source 必须属于所选 session；source 不存在时不再到其他 session 自动寻找。

典型流程：

```text
MemorySearch / MemoryGet
  → 返回 sourceSessionId
RecallSearch({sessionId: sourceSessionId, query: "关键字"})
  → 返回 source
RecallGet({sessionId: sourceSessionId, source})
  → 返回历史原文
Read / Grep
  → 按需验证当前代码
```

不增加默认 turn 范围或无 query 的列举模式。`turn_from`、`turn_to`、角色、工具过滤和
分页继续沿用现有语义，只是作用于选中的 session。

## 二、结果明确标记来源

保留现有 `kind: "recall"`、`mode: "search" | "get"` 和 page 结构，不新增 raw result kind。
新产生的成功结果在外层增加实际的 `sessionId`、`workspaceRoot`，包括当前 session 的调用。

Observation 显示来源 session/workspace，并提示：读取原文或下一页时继续传相同 sessionId。
所有 ordinal、turn number 和 `snapshotThroughOrdinal` 都是所选 session 内的编号。

Search 分页继续使用现有 `snapshot_through_ordinal` 上界；不要混用另一个 session 的
snapshot。不同 session 恰好有同一个 ordinal 并不表示它们是同一份快照。Get 分页沿用
UTF-8 安全边界、完整内容哈希校验和现有字节上限。

历史结果仍是历史，不因读取而变成当前事实或当前指令。哈希证明内容与 canonical 存储
一致，不证明当时的说法真实。图片保持现有 Recall 的文本/附件标记行为，不扩展图像读取。

## 三、按 sessionId 定位数据库

当前数据位于：

```text
<Tinker home>/.tinker/projects/<workspace-slug-hash>/sessions/<sessionId>/session.sqlite
```

sessionId 不包含 workspace，因此不能只在当前项目目录查找。新增一个小型 session locator，
在当前配置的 Tinker home 中按 ID 定位，支持同工作区和跨工作区 session。

建议直接利用现有目录布局，不增加全局索引或数据库表：

1. 按当前 workspace 的路径算法检查候选目录。
2. 枚举 `projects/` 的直接项目子目录，在各目录下检查 `sessions/<sessionId>`；不递归扫描
   工作区、不遍历消息正文、不为其他 ID 打开数据库。
3. 唯一候选才允许读取；不同目录出现相同 sessionId 时返回歧义错误，不选择第一个。
   因此检查当前 workspace 候选后，仍需完成其他项目的同 ID 检查。
4. 打开后验证 `session_meta.session_id` 与请求一致，workspace metadata 与存储目录的
   派生关系一致，且初始化已完成。目录名不是唯一的身份依据。

仅在配置的 Tinker home 下查找，不接受模型传入文件路径、workspace 路径或任意数据库。
缺失目标与目录枚举失败要区分；没有完成查找不能报告“session 不存在”。

源 workspace 目录可能已移动或删除。读取保留下来的历史不要求该工作区仍存在：使用库中
记录的 canonical workspace 路径计算预期存储目录，不对旧 workspace 再调用 realpath。

首版逐次定位、不持久化映射，不缓存数据库连接；当前 session 走快路径。实际目录规模
产生性能问题后，再考虑带失效处理的路径缓存，不提前引入维护成本。

## 四、只读打开并复用现有 reader

增加 session 层的只读访问入口，工具只负责参数和结果，不直接管理 SQLite：

```text
RecallSearch / RecallGet
  → sessionId 缺省或等于当前 ID：现有 historyReader
  → 其他 sessionId：locator → 只读连接 → SessionHistoryReader → 关闭连接
```

可以用 `withHistoryReader(sessionId, callback)` 一类内部接口管理生命周期。
`src/session/session-history-reader.ts` 已支持指定 database/sessionId，优先复用它的搜索、
解码、渲染、分页和校验逻辑，不复制一套查询实现。

必要约束：

- 只读打开，复用现有私有目录/文件校验，拒绝符号链接和不安全路径；验证 DB 及现有
  WAL/SHM。不存在时不创建，权限不合格时不自动修复。
- 不调用执行态的 `SessionStore.openExisting()`，不获取执行锁、不 resume、不恢复中断
  尾部、不改 metadata、不迁移或重建 FTS。
- 使用短读事务，让同一次 Search/Get 内的多条 SQL 读取同一份已提交快照；finally 关闭
  连接，不跨模型迭代保留连接或事务。
- 允许读取另一进程正在使用的 session，通过 SQLite 只读快照读取已提交的消息。不会等待
  整个 turn 结束，也不增加 completed-turn 过滤。进行中或中断的 turn 可能只有部分历史，
  不能据此推断任务已完成。
- 读取的是历史数据，不是将目标 session 的消息重新作为执行上下文；旧 Skills、MCP、模型
  配置和用户授权都不激活。模型或项目指令变化不应阻止结构合法的旧历史阅读。
- 初版仅支持现有 reader 可直接读取的 `current` schema；识别为 `migratable` 或未知版本
  时返回不支持，不在查询中升级源库。
- 读取前后检查取消信号，busy 等待有界；不声称可以抢占同步 SQLite 查询。

只读不等于数据库目录绝无变化：SQLite WAL 读取可能涉及 SHM 协调。需在 macOS/Linux
验证实际行为；不得为读取切换 journal mode 或降级成可写连接，也不能用 `immutable=1`
忽略活跃 WAL。无法安全只读打开时返回错误。保证是不改变来源 canonical 数据、索引和
执行状态，而不是对活跃 writer 的整个目录承诺字节不变。

## 五、错误处理

沿用现有 Recall 错误结构和 `errorCode`。只增加目标 session 层必需的错误，例如：

| 情况 | 处理 |
| --- | --- |
| sessionId 非法 | `RECALL_ARGS_INVALID` |
| 找不到目标 | `RECALL_SESSION_NOT_FOUND` |
| 多处存在相同 ID | `RECALL_SESSION_AMBIGUOUS` |
| 格式需迁移或版本不支持 | `RECALL_SESSION_UNSUPPORTED` |
| 权限、身份、schema 损坏、I/O、busy 或索引不可用 | `RECALL_SESSION_UNAVAILABLE`，附有界原因 |
| source、snapshot、字节分页错误 | 复用现有对应 Recall 错误 |

有效查询但没有命中依然成功返回空 hits，不能与打不开目标库混淆。

当前实现将当前 session 的 `SessionError` 升级为 fatal。此处必须区分两条路径：

- **当前 session 的必要历史存储失败**：保持现有 fatal 语义。
- **外部 session 不可用或内容校验失败**：普通工具错误，不使当前 session fault；不返回
  校验失败的正文，也不静默查别处。

外部读取失败不会触发自动删除记忆、修复来源库或无限重试。当前会话自身写入工具结果
失败，仍遵守原有持久化错误边界。

## 六、接线与兼容性

### 代码改动范围

| 位置 | 改动 |
| --- | --- |
| `src/tools/recall.ts` | 两个 schema/解析器增加 sessionId，选择 reader，补来源和错误映射 |
| `src/session/` | 新增 locator 和短生命周期只读打开入口，复用现有 reader |
| runtime / 默认工具组装 | 向 Recall 注入 reader 访问能力；TUI、one-shot 都可使用 |
| `src/tools/types.ts`、observation/TUI | 沿用 recall kind，补可选来源字段和错误码 |
| 记忆工具描述及 observation | 将溯源指导改为 `RecallSearch/Get({sessionId: sourceSessionId, ...})` |
| 对应测试与文档 | 覆盖跨 session、老结果恢复和原有当前 session 行为 |

Memory 不是依赖：即使未启用全局记忆，Recall 也能读取明确指定的 session。one-shot 无需
先接入整套 Memory。新工具集合没有变化，现有对 Recall 工具结果的索引排除规则继续适用。

### 持久化兼容

不增加 SQL 表或修改 schema。读取旧的 recall raw result 时，来源字段允许缺省；展示旧
结果不能假定所有记录都有新增字段。新代码必须能够 resume/fork 包含旧、新 Recall 结果
的 session。

若修改历史工具结果的展示逻辑，不重写已存 observation。是否能由旧程序读取新结果需
独立验证，不能仅因 SQL schema 不变就承诺支持降级。

### 上下文自动维护资格

Recall 的工具定义关联已有主动 Recall qualification。增加字段会改变定义 hash；实施时
检查资格校验和当前 session 回归，按已有机制重新评测/更新报告。不得只改 hash 常量绕过
资格门禁，也不为避免这项正常变更成本而另造工具。

## 七、数据范围与非目标

显式 sessionId 允许读取当前 Tinker home 中其他 workspace 的历史，不新增同工作区限制
或确认 UI。原文会发送给当前模型提供方，并作为工具结果保存在当前 session；跨项目、
跨提供方的数据流转需要在工具说明和用户文档中明确。

这仍是本地个人 coding agent 的读取能力，不是新的 OS 沙箱或完整权限系统。保留已有
路径和私有文件检查，不用模型传入的布尔开关模拟授权。

本次不做：

- 新增 MemorySource 工具、memoryId 绑定、source turn 导航层。
- 全局全文搜索、session 列表工具、向量索引或自动历史注入。
- 记忆修订链、逐结论证据验证、来源删除后的自动记忆清理。
- 旧库迁移、存储搬家、后台进程恢复或权限平台。

## 八、测试与完成标准

### 必要回归

1. 不传 sessionId 与显式当前 ID 的搜索、分页、哈希及错误行为一致；不额外打开当前库。
2. 同工作区/跨工作区两个 session，指定 ID 后只能读到目标历史；Memory 未启用时也可用。
3. Search 返回来源，Get 带相同 sessionId 能拿到原文；错配 source 不会自动跳库。
4. 非法 ID、目录遍历输入、目标缺失、重复 ID、权限/符号链接、身份不匹配、未知 schema。
5. 来源正在追加或有中断尾部时，读取已提交历史且不恢复、不迁移、不修改执行状态；跨页
   复用目标 snapshot 后不会混入后续追加。
6. 源库损坏/哈希失败/busy/取消后，当前 session 仍可工作，连接正确释放；当前库 fatal
   行为没有被一并弱化。
7. 中文 UTF-8 分页、图片文本标记、大 observation、老/新 Recall 结果的 resume 和 fork。
8. 来源 workspace 已不存在但存储仍保留时可读；TINKER_HOME 隔离和不完整扫描错误明确。
9. 静态源库只读不变、活跃 WAL 正确读取、检索结果始终排除已有 Recall 工具复制内容。

### 完成定义

> 两个 Recall 工具都能通过可选 sessionId 选择历史，不传时保持现有行为；目标库只读，
> 来源明确，失败不回退、不破坏当前会话。Memory 返回的 sourceSessionId 可以直接用于
> Search → Get，无需新工具或额外产品机制。

实施涉及源码和测试时，按项目约定迭代运行 `bun run check:fast`，完成前运行
`bun run check`；真实模型 qualification 与离线回归结果分开报告。

## 实施与验证记录（2026-09-05）

- 新增 `src/session/session-history-access.ts`：按配置 home 定位唯一 session，验证私有路径、
  DB/WAL/SHM、schema、session/workspace 身份及 ready 状态；只读短事务复用现有 reader，
  busy timeout 为 250ms，finally 严格关闭连接。当前 session 复用注入的 reader。
- 默认工具组装为 TUI/one-shot 同时启用；Memory 不参与依赖。Recall 成功结果及
  observation/TUI 标记来源，旧结果缺省字段仍可恢复；Memory 指导明确传 `sourceSessionId`。
- 回归覆盖同/跨工作区、默认快路径、分页/哈希、错误隔离、源 workspace 删除、
  活跃 WAL/部分 turn、同事务快照、静态库不变、权限/符号链接、歧义、不完整扫描、
  迁移拒绝、损坏/索引缺失、busy/取消、图片省略以及老/新结果 resume/fork。
- 本机 macOS + Bun 1.3.14 的只读/WAL/SHM、独立进程 busy 读取已验证。Linux 尚未实测：
  本机 Docker CLI 存在但 daemon 不可连接，不能把 macOS 结果当作 Linux 验证。

- 离线质量门禁：`bun run check:fast` 通过（1124 tests）；`bun run check` 通过
  （1167 tests，含真实进程 E2E、docs:check 和 benchmark smoke），无失败。

### 真实模型 qualification（与离线回归分开）

按原冻结 manifest/policy 运行 `deepseek-v4-flash` 的完整 holdout：90 个正例试验
（10 cases × 3 views × 3 trials）及 9 个负例。未调整门槛、未筛选试验、未重跑择优。

- full-history 成功率 96.67%；swap-only 100%；Recall-only 100%。
- Recall-only 主动 Recall 100%，Search → Get 13.33%，低于冻结门槛 30%。
- Recall-only 无效调用/试验为 0；负例不必要 Recall 为 0。
- token/latency 相对 full-history 比率分别为 0.2813 / 0.8764。
- 评测最终 `passed=false`，报告及其自动化建议保持原样。初次实施据此关闭了自动
  prefix retirement；用户随后明确要求此次只改进 Recall，保留自动 retirement 开启。
- 最初通过 `recall-session-selection-continuity-v1` 记录保留开启的决定。随后用户精简
  Recall description，并从 MemorySearch/Get description 删除重复的 Recall 调用指导
  （模型观察不变），再次明确要求本次文案修改保留自动维护开启。当前使用
  `recall-session-selection-description-continuity-v2`，分别绑定原评测工具 hash
  `0af1dcea5ccbb0619c36d2bf0df1e183a0213b1a5b8b2a6181c38a0fc79705eb` 与精简后工具 hash
  `072ffe5ee810bcd06ae681eb3749400ab6e9219c3d762e3e0e0ad5cc9573d53e`，同时保持
  Recall contract 和正负报告 hash 绑定。原始报告及 `passed=false` 不变；精简后的文案
  尚未重新进行真实模型评测，现有 evaluator 必须拒绝把旧报告当作当前 surface 的证据。
- 仍检查 profile 与 surface 匹配；自动 swap/retirement 的触发、规划和执行安全条件不变，
  未来 surface/report 变更不继承这次例外。事件沿用 qualificationId 字段记录当前
  decision ID，不假称评测通过。
- 此决定不改变冻结评测门槛：30 个 Recall-only 试验都成功 Search、任务全部通过，
  其中 26 次没有调用 Get；Search 摘要可能已经足够，调用比例不能单独证明能力下降。
  后续可独立改进评测题目，本次不修改评测策略。手动 `/compact retire` 不受影响。

完整原始报告与机器判定保存在本地 `.data/evaluations/`，不纳入 Git。
常规测试使用合成报告验证评测规则，不依赖这些历史归档。

## 参考

- [Recall 工具实现](../src/tools/recall.ts)
- [全局记忆现状](global-memory/global-memory-design.md)
- [自动上下文维护与模型评测解耦](context-automation-evaluation-decoupling.md)
