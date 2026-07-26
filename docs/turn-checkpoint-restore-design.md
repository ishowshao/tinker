# Turn 级工作区 Checkpoint 与恢复技术方案

## 文档状态

- 日期：2026-07-26
- 状态：待实施
- 前置能力：F3 协议安全账本、F4 SessionStore/resume、turn cancellation（均已完成）
- 关联文档：[`protocol-safe-session-ledger-design.md`](protocol-safe-session-ledger-design.md)、
  [`session-store-resume-design.md`](session-store-resume-design.md)、
  [`turn-cancellation-design.md`](turn-cancellation-design.md)、
  [`product-hardening-roadmap.md`](product-hardening-roadmap.md)

## 一、结论先行

Tinker 已经能把会话历史做到"可保存、可恢复、可计量、可找回"，但工作区文件修改仍是
单向的：Write/Edit 一旦成功，旧内容只存在于当次 tool result 的 diff 里，用户想撤销
"上一轮 agent 干的活"只能手工回填。

本设计为 Write/Edit 引入 **turn 级文件 checkpoint**：每个 turn 首次修改某个文件前，
把该文件的 pre-turn 状态完整捕获到 session 存储中；用户通过 `/undo` 把整个 turn 的
文件修改一次性回滚。

核心决策：

1. **聚合粒度是 turn，不是单次 Edit**。用户要撤销的语义单位是"那次让 agent 干活"，
   一个 turn 改 10 个文件应当一次回滚，而不是做 10 次单文件 undo。
2. **checkpoint 严格先于变更落账**。每个文件的 pre-state 在 `writeFile()` 之前完成
   blob + 元数据提交；capture 失败则本次写入 fast-fail，文件保持不动。
3. **checkpoint 是工作区状态管理，不触碰 canonical history**。历史如实记录"agent
   做过这些修改"这一事实；恢复只改变工作区，并以一条 runtime 合成消息把"用户已
   回滚"告知后续模型请求。
4. **恢复本身也是可逆的**。`/undo` 执行前先把当前状态捕获为一个 safety checkpoint，
   恢复失败或用户反悔时仍有完整退路。
5. **drift 检测兜底捕获盲区**。Bash、MCP、用户手工修改不在捕获范围内；恢复时逐文件
   比对 `last_known_sha256`，发现 turn 之后的未知变更默认拒绝，显式 `--force` 才覆盖。

非目标见第四节；本设计不引入 git 依赖、不做目录级快照、不做 Bash 副作用捕获。

## 二、当前实现基线与接缝

本设计基于已落地的接口实施，不重新发明存储和生命周期：

1. **Write/Edit 已经在写盘前持有完整 pre-state**。
   `src/tools/write.ts` 在 `targetFileState()` 后持有 `oldContent` / `oldSha256`
   （文件不存在时 `oldSha256 = null`）；`src/tools/edit.ts` 的 `writeEditedContent()`
   在 `writeFile()` 前同样持有 `oldContent` / `oldSha256` / `created`。
   捕获不需要额外读盘。
2. **turn 身份与生命周期已经完备**。`turns` 表有 `turn_id`、`turn_number`、
   `status (open/completed/failed/cancelled/interrupted)`；`RuntimeSession` 是
   turn 的唯一 owner，terminal 路径集中。
3. **工具已接收 `ToolExecutionContext`**（turn cancellation 落地时引入），
   executor 由 `src/tools/registry.ts` 按 session 构建一次，可以追加 session 级
   checkpoint sink。
4. **session 目录布局已固定**：`.tinker/sessions/<sessionId>/` 下有 SQLite、
   `events.jsonl`、`observations.md`、`active.lock`。image asset store 提供了
   内容寻址文件存储的先例。
5. **SessionStore 已有 schema 迁移机制**（当前 v9，STRICT 表 + fingerprint），
   `/session delete` 已有级联清理路径，session fork 已有"哪些状态复制、哪些不
   复制"的既有判例。
6. **TUI slash command 分发已收口**：`tui-session-controller.ts` 用 `serialize()`
   把 `/compact`、`/fork` 这类会话级操作串行化，`/undo` 复用同一通道。
7. **FileSnapshotStore 是 read-before-write 的唯一事实来源**。恢复后必须同步它，
   否则 Edit 的 drift 检查会基于过期 hash。

## 三、用户可见语义

### 3.1 无感捕获

- 模型通过 Write/Edit 修改文件时，用户不做任何操作即被 checkpoint 保护。
- 只读 turn（没有文件变更）不产生 checkpoint，不出现在 `/undo` 视野里。
- turn 完成且产生过文件变更时，timeline 末尾显示一行提示，例如：
  `3 files changed · /undo to restore`。

### 3.2 `/undo` 命令族

沿用现有 slash command 的 token 解析风格：

```text
/undo                    恢复最近一次有文件变更的 turn
/undo list               列出本 session 最近的可恢复 checkpoint
/undo <turn-number>      恢复指定 turn
/undo <turn-number> --force
                         drift 冲突时强制覆盖（逐文件确认语义见 7.4）
```

- `/undo` 只在 TUI 空闲时可用；turn 执行期间走 `serialize()` 排队语义，与
  `/compact` 一致，直接拒绝并提示。
- `/undo` 是**用户操作，不是模型工具**。不向模型注册任何 checkpoint/restore
  工具，避免模型自行回滚造成历史和文件状态的解释分歧。
- 恢复成功后输出逐文件结果（restored / deleted / skipped），并提示该操作本身已
  生成 safety checkpoint。
- one-shot CLI 第一版不支持 `/undo`；checkpoint 仍然捕获，恢复留给之后 resume 该
  session 的 TUI。

### 3.3 恢复语义示例

```text
turn 7: agent 新建 a.ts，修改 b.ts（两次 Edit），修改 c.ts
  -> checkpoint(turn 7) = { a.ts: absent, b.ts: pre-turn 内容, c.ts: pre-turn 内容 }

/undo
  -> a.ts 被删除（turn 7 创建的文件）
  -> b.ts、c.ts 写回 pre-turn 内容
  -> b.ts 在 turn 内的第二次 Edit 不产生第二个 checkpoint 条目
```

连续 `/undo` 即按 turn 倒序逐个回滚。跨 turn 的顺序依赖由 drift 检测表达：
turn 8 又改了 b.ts 时，直接 `/undo 7` 会发现 b.ts 当前内容不等于 turn 7 结束时的
`last_known_sha256`，默认拒绝。

## 四、目标与非目标

### 4.1 目标

1. 每个有文件变更的 turn 产生恰好一个 checkpoint，按 `turn_id` 唯一。
2. turn 内同一文件的多次修改只捕获一次 pre-state（first-mutation-wins）。
3. checkpoint 条目严格先于对应文件变更提交；capture 失败则该次 Write/Edit 失败且
   文件不被修改。
4. checkpoint 随 session 持久化，进程中断、resume 之后仍可恢复。
5. `/undo` 恢复整个 turn 的文件状态：修改过的写回 pre-turn 内容，turn 内新建的文件
   被删除。
6. 恢复前 drift 检测：当前文件与 checkpoint 记录的 `last_known_sha256` 不一致时
   默认整体拒绝，不产生部分恢复。
7. 恢复操作自身先捕获 safety checkpoint，保证 `/undo` 可反悔。
8. 恢复结果同步 FileSnapshotStore，并向 canonical history 注入一条 runtime 合成
   消息，使下一个模型请求知道工作区已回滚。
9. checkpoint 元数据和 blob 有确定性的保留与清理策略，随 `/session delete` 级联删除。

### 4.2 非目标

第一版不做：

- Bash、MCP 工具或任何外部进程的文件变更捕获（仅以 drift 检测兜底）。
- 目录级快照、git 集成、worktree 或 reflog 语义。
- 跨 turn 的范围回滚（`/undo 3..7`）；逐 turn 重复 `/undo` 已覆盖该需求。
- 独立的 `/redo` 命令；redo 由 safety checkpoint 事实支持，UX 留给后续。
- 二进制文件 checkpoint（Write/Edit 本身是 UTF-8 文本工具）。
- checkpoint 的模型可见工具或模型触发的恢复。
- one-shot CLI 的恢复入口。
- fork 时复制 checkpoint（fork 出的新 session 不继承原 session 的 checkpoint，
  与 fork 不复制事件日志的既有判例一致）。

## 五、必须保持的不变量

```text
capture 严格先于 mutation：文件的 checkpoint 条目提交前，writeFile 不得开始
first-mutation-wins：同一 (checkpoint, path) 只保留 pre-turn 状态
last_known_sha256 只记录 runtime 亲自验证过的内容 hash
checkpoint 不影响 canonical message、frame、ordinal 与 context revision
恢复是整体操作：任一文件 drift 冲突且未 --force 时，所有文件保持不动
恢复前必须先完成 safety checkpoint 捕获，否则恢复不得开始
只有持有 session lock 的活跃 runtime 可以捕获或恢复 checkpoint
session delete 必须级联删除 checkpoint 元数据与 blob
```

`last_known_sha256` 的精确定义：runtime 最近一次亲自写盘并 `stat` 验证后的内容
hash。外部进程在 turn 之后修改文件不会造成 `last_known_sha256` 的误更新，因为
它只在 Write/Edit 成功路径上推进。

## 六、数据模型

### 6.1 Schema v10：checkpoint 元数据

元数据进入 session SQLite，与 turns 同事务域，享受既有的 single-writer lock、
迁移和 `/session delete` 级联清理：

```sql
CREATE TABLE workspace_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL UNIQUE,
  turn_number INTEGER NOT NULL CHECK (turn_number >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'restore_safety')),
  status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'interrupted', 'restored')),
  restores_checkpoint_id TEXT,
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  restored_at TEXT,
  UNIQUE (session_id, turn_id),
  FOREIGN KEY (session_id) REFERENCES session_meta(session_id),
  FOREIGN KEY (turn_id) REFERENCES turns(turn_id),
  FOREIGN KEY (restores_checkpoint_id) REFERENCES workspace_checkpoints(checkpoint_id)
) STRICT;

CREATE TABLE workspace_checkpoint_entries (
  checkpoint_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  pre_state TEXT NOT NULL CHECK (pre_state IN ('absent', 'present')),
  pre_sha256 TEXT,
  pre_byte_length INTEGER,
  last_known_sha256 TEXT,
  last_known_state TEXT NOT NULL CHECK (last_known_state IN ('absent', 'present')),
  restore_state TEXT NOT NULL CHECK (restore_state IN ('pending', 'restored', 'deleted', 'skipped')),
  PRIMARY KEY (checkpoint_id, relative_path),
  FOREIGN KEY (checkpoint_id) REFERENCES workspace_checkpoints(checkpoint_id),
  CHECK ((pre_state = 'absent') = (pre_sha256 IS NULL)),
  CHECK ((pre_state = 'present') = (pre_sha256 IS NOT NULL AND pre_byte_length IS NOT NULL))
) STRICT;
```

字段说明：

- `kind = 'restore_safety'` 的 checkpoint 不挂在真实 turn 上；`turn_id` 复用恢复
  发生时所处 session 的标识语义——为避免伪造 turn，safety checkpoint 的 `turn_id`
  记录被恢复 checkpoint 的 `turn_id`，`restores_checkpoint_id` 指向目标 checkpoint，
  `turn_number` 记录目标 turn 号。恢复 UX 不列出 safety checkpoint，只在 drift 冲突
  等诊断场景可见。
- `last_known_sha256` / `last_known_state`：turn 内每次成功 Write/Edit 后推进；
  turn 创建的文件初始为创建后的 `newSha256`。恢复时的 drift 基准。
- `status` 只允许 `open -> completed | interrupted -> restored` 的单调转换。
  `restored` 表示该 checkpoint 已被一次 `/undo` 消费；允许重复恢复同一 checkpoint
  （幂等写回相同内容），但每次恢复仍生成新的 safety checkpoint。

### 6.2 内容寻址 blob 存储

pre-turn 文件内容存放到 session 目录下的内容寻址 blob：

```text
.tinker/sessions/<sessionId>/checkpoints/blobs/<sha256>
```

- 文件名即内容 sha256，天然去重：同一文件在多个 turn 的 pre-state 相同、或大文件
  反复小幅修改时，blob 只存一份。
- 写入使用 `wx` 语义，EEXIST 视为成功（内容相同必然同 hash）。
- `pre_state = 'absent'` 的条目不写 blob。
- 单 blob 上限 10 MiB、单 checkpoint 总上限 64 MiB；超限的 Write/Edit fast-fail
  并给出明确错误（这类文件不应经由文本写入工具修改）。两个上限写入公共配置契约
  文档，但不新增用户可调配置项。
- blob 是恢复数据的唯一内容来源；SQLite 不复制正文，避免双份漂移。

### 6.3 保留与清理

- 每个 session 保留最近 50 个 `kind = 'turn'` 的 checkpoint；超出后按 turn_number
  从旧到新 prune，prune 时删除无其他条目引用的 blob（同 session 内 refcount 由
  内容寻址天然支持：统计所有存活条目的 `pre_sha256`）。
- safety checkpoint 跟随其目标 checkpoint 的生命周期，不单独计数。
- `/session delete` 删除 session 目录时整体移除 `checkpoints/` 子树，无需逐条
  清理。
- prune 只删除 `restored` 或最旧且未被 safety checkpoint 引用的记录；当前活跃
  turn 的 open checkpoint 永不 prune。

## 七、捕获流程

### 7.1 CheckpointSink 接缝

`src/tools/registry.ts` 构建 tooling 时创建一个 session 级 `CheckpointSink`；
`RuntimeSession` 在 turn 边界驱动它：

```ts
export type CheckpointCapture = {
  relativePath: string;      // 相对 workspaceRoot 的规范路径
  absolutePath: string;
  preState: "absent" | "present";
  preContent?: string;       // present 时必有
  preSha256?: string;        // present 时必有
};

export type CheckpointSink = {
  beginTurn(identity: TurnIdentity): void;
  captureFirstMutation(capture: CheckpointCapture): Promise<void>;
  recordMutationResult(relativePath: string, newSha256: string): Promise<void>;
  finishTurn(status: "completed" | "failed" | "cancelled" | "interrupted"): Promise<void>;
};
```

- `beginTurn` 不创建任何记录；checkpoint 是惰性的，第一次 `captureFirstMutation`
  才在同一 SQLite 事务中插入 checkpoint 行（`status = 'open'`）和首个条目。
- `captureFirstMutation` 对已存在的 `(checkpoint, relative_path)` 幂等跳过
  （INSERT OR IGNORE 语义），实现 first-mutation-wins。
- `recordMutationResult` 只在写盘并 `stat` 验证后推进 `last_known_*`。
- `finishTurn` 把 open checkpoint 标记为 `completed` 或 `interrupted`（turn failed /
  cancelled 但已捕获过变更时，同样标记 completed——变更已经发生，恢复语义与 turn
  结局无关；`interrupted` 只用于进程中断后 resume 发现的 open 状态）。
- turn 没有任何文件变更时，`finishTurn` 是 no-op，不产生空 checkpoint。

### 7.2 Write/Edit 集成点

两个工具的执行路径在 `writeFile()` 前插入捕获，顺序固定为：

```text
targetFileState()               // 现有：读出 oldContent / oldSha256
  -> 现有 snapshot / drift 校验
  -> sink.captureFirstMutation({ preState, preContent, preSha256 })
       ├─ 写 blob（present 时，wx，EEXIST 放行）
       └─ SQLite 事务：ensure checkpoint row + INSERT OR IGNORE entry
  -> 现有 ensureParentDirectory / writeFile / stat
  -> sink.recordMutationResult(relativePath, newSha256)
  -> 现有 FileSnapshotStore.set(...)
```

关键顺序约束：

- **capture 在 writeFile 之前**。blob 或元数据失败 -> 返回 `ok: false` 工具错误，
  文件未被触碰；错误信息明确区分"checkpoint 不可用"与普通写入失败。
- capture 成功但 writeFile 失败 -> 条目存在但 `last_known_*` 仍等于 pre-state，
  当前文件也仍是 pre-state，恢复对该条目是幂等 no-op。这是安全方向。
- Edit 的 `old_string = ''` 创建路径走同一 capture：文件不存在为 `absent`，
  存在但为空为 `present`（pre_content 为空串，blob 仍存在）。
- capture 不响应 turn signal：它与 writeFile 同属一次提交临界区，遵循 turn
  cancellation 设计的安全边界原则。

### 7.3 路径规范

- `relativePath` 一律为相对 `workspaceRoot` 的 POSIX 风格规范路径；
  `resolveWorkspacePath` 之后计算，拒绝越过 workspace 的路径在现有 path-safety
  层已经失败，不会到达 capture。
- 同一文件的相对/绝对两种写法必须归一到同一条目；以 `resolveWorkspacePath` 输出
  为唯一事实来源。

## 八、恢复流程

### 8.1 入口与前置条件

`/undo` 由 TUI slash command 进入 `tui-session-controller.serialize()`，最终调用
`RuntimeSession.restoreCheckpoint(target)`。前置条件：

- session 持有 lock 且处于 ready（无活跃 turn、无活跃 context revision 操作）；
- 目标 checkpoint 属于当前 session 且 `status IN ('completed', 'interrupted',
  'restored')`；
- 无参数 `/undo` 选择 `turn_number` 最大且非 safety 的 checkpoint。

### 8.2 恢复算法

```text
load checkpoint + entries
  -> Phase 1 逐条目 drift 检测（只读）：
       pre_state/last_known_state 与当前文件 existence 比对
       当前 sha256 与 last_known_sha256 比对
       任一条目不一致 -> 收集完整冲突列表，整体拒绝（除非 --force）
  -> Phase 2 safety capture：
       对全部条目捕获当前状态为 restore_safety checkpoint
       safety capture 失败 -> 整体拒绝，不开始任何写盘
  -> Phase 3 逐条目应用：
       pre_state = absent  -> unlink 当前文件（不存在视为成功）
       pre_state = present -> 从 blob 读内容，writeFile 写回，stat 验证 hash
  -> Phase 4 落账与同步：
       条目 restore_state、目标 checkpoint status = restored
       FileSnapshotStore：restored 文件 set(restored hash, source 'restore')；
                          deleted 文件删除 snapshot 条目
       注入 runtime 合成消息（见 8.4）
       提交 workspace.restored 事件
```

- Phase 3 中单个条目写盘失败：已恢复的条目保持 restored 状态，失败条目标记
  `skipped` 并继续处理其余条目，最终向用户报告逐条目结果和 safety checkpoint
  身份。**不尝试中途回滚已恢复的条目**——safety checkpoint 就是回滚机制。
- `--force` 只跳过 Phase 1 的拒绝，不改变后续阶段；safety capture 仍然强制执行，
  因此 force 恢复同样可反悔。
- 恢复不删除 turn 创建文件的空父目录（`ensureParentDirectory` 可能创建过），
  第一版文档化此行为。

### 8.3 与 FileSnapshotStore 的一致性

恢复后 runtime 精确知道每个 restored 文件的内容（自己写入并验证过），因此直接
把 snapshot 设置为恢复后的 hash，`source: 'restore'`。这样后续 Edit 不需要强制
重新 Read，同时 drift 检查仍然有效。被删除的文件删除 snapshot 条目，后续 Write
按"文件不存在"路径处理。

### 8.4 注入 canonical history

恢复是工作区事件，但模型必须知道，否则下一轮它会基于"文件是我改过的样子"推理。
恢复落账时由 `RuntimeSession` 追加一条 user role、origin 为 runtime 的合成消息，
文案确定性生成，例如：

```text
The user restored the workspace to its state before turn 7 via /undo.
3 files were reverted (a.ts deleted; b.ts, c.ts restored). The edits from
that turn remain in history but no longer exist on disk. Inspect current
file state before building on it.
```

- 该消息走与 skill settlement 相同的 RuntimeSession 注入通道，构成一个普通 closed
  user frame，不修改任何已有记录。
- context revision、swap、retirement 机制无需任何特判：注入消息就是普通历史。
- 恢复事件不伪造 tool result，也不触碰 turn 7 的任何 message。

## 九、失败矩阵

| 失败点 | 文件状态 | checkpoint 状态 | 用户可见结果 |
| --- | --- | --- | --- |
| blob 写入失败 | 未修改 | 无条目（同事务回滚） | Write/Edit 返回 checkpoint 不可用错误 |
| 条目事务失败 | 未修改 | 可能有孤儿 blob | 同上；blob 由 prune 回收 |
| writeFile 失败（capture 已成功） | 未修改 | 条目 last_known = pre | 工具返回原写入错误；恢复为幂等 no-op |
| turn 进程中断 | 已改文件保持 | open checkpoint | resume 时标记 interrupted，仍可恢复 |
| drift 检测冲突（无 force） | 全部未修改 | 不变 | 逐文件冲突报告 |
| safety capture 失败 | 全部未修改 | 不变 | 整体拒绝，提示原因 |
| Phase 3 单条目写盘失败 | 部分恢复 | 失败条目 skipped | 逐条目报告 + safety checkpoint 身份 |
| blob 缺失/损坏（恢复时） | 全部未修改 | 不变 | 整体拒绝，报告缺失条目 |

孤儿 blob（capture 事务回滚后残留）不影响正确性，由保留策略统一回收。

## 十、与现有子系统的衔接

### 10.1 Resume 与进程中断

- resume 时 session open 流程把 `status = 'open'` 的 checkpoint 标记为
  `interrupted`（与 turns 的 interrupted recovery 同批处理）。
- interrupted checkpoint 与 completed checkpoint 恢复语义完全相同：捕获发生在
  每个 writeFile 之前，中断只可能损失"最后一次 writeFile 的 last_known 推进"，
  drift 检测会在恢复时客观发现。
- 不从 event log 猜测 checkpoint 状态；SQLite 是唯一事实来源。

### 10.2 Turn cancellation

- 取消不触发任何 checkpoint 回滚，与"取消不撤销副作用"的既有语义一致。
- 取消时 turn 已产生的文件变更照常保留在 checkpoint 中，`/undo` 可用。

### 10.3 Fork / session delete / 多 session

- `/fork` 不复制 checkpoint 元数据和 blob；fork 出的 session 从空 checkpoint 开始。
- `/session delete` 级联删除；不得删除仍被其他 session 引用的任何数据（blob 按
  session 隔离，天然满足）。
- 多 session 并发修改同一工作区文件时，各 session 的 checkpoint 各自独立；跨
  session 的相互覆盖由恢复时的 drift 检测客观暴露，不做跨 session 协调。

### 10.4 Context 机制

checkpoint 与 context revision、swap、retirement 完全正交：不改写历史，不参与
token 计量，不出现在 provider 请求里（8.4 的注入消息除外，它是普通 user 消息）。

## 十一、事件与 TUI

新增事件（沿用 JSONL / observation log / TUI 三 sink 惯例）：

```ts
type WorkspaceRestoredEvent = {
  type: "workspace.restored";
  checkpointId: string;
  turnNumber: number;
  restored: readonly string[];   // relative paths
  deleted: readonly string[];
  skipped: readonly { path: string; error: string }[];
  safetyCheckpointId: string;
  forced: boolean;
};
```

- turn 完成且产生 checkpoint 时，不新增事件类型；在既有 turn 终态事件的
  `terminal_detail_json` 中附带 `{ checkpoint: { entryCount } }`，TUI 据此渲染
  `N files changed · /undo to restore` 提示。
- `/undo list` 是纯查询，从 SQLite 读取最近 20 个 turn checkpoint（turn number、
  时间、文件数、状态），不新增事件。
- ObservationTextLog 为 `workspace.restored` 增加人类可读段落；StdoutEventPrinter
  输出稳定单行摘要。

## 十二、代码落点

| 文件 | 主要变更 |
| --- | --- |
| `src/session/session-schema.ts` | schema v10：两张新表、迁移、fingerprint 更新 |
| `src/session/session-store.ts` | checkpoint CRUD：惰性创建、条目 upsert、last_known 推进、finish、查询、prune |
| `src/tools/checkpoint-store.ts` | 新增：blob 内容寻址读写、大小上限、孤儿回收 |
| `src/tools/checkpoint-sink.ts` | 新增：`CheckpointSink` 接口与 session 级实现 |
| `src/tools/write.ts` / `src/tools/edit.ts` | writeFile 前 capture、写后 recordMutationResult |
| `src/tools/registry.ts` | 构建 sink 并注入 Write/Edit executor options |
| `src/agent/runtime-session.ts` | turn 边界驱动 begin/finish；`restoreCheckpoint()`；resume 时 open -> interrupted；注入恢复合成消息 |
| `src/session/session-schema.ts` 迁移测试 | v9 -> v10 升级与降级拒绝 |
| `src/tui/slash-commands.ts` | `/undo` 命令族解析 |
| `src/tui/tui-session-controller.ts` | `restore()` 经 serialize() 分发 |
| `src/events/types.ts` 等三 sink | `workspace.restored` |
| `src/cli/config.ts` | checkpoint blob 目录路径 helper |
| `docs/` 公共契约文档 | blob/容量上限与 `/undo` 命令进入生成文档 |

## 十三、分步实施顺序

### C1：纯领域层

1. schema v10 两张表 + 迁移。
2. blob 内容寻址存储（写入、去重、上限、读取校验）。
3. SessionStore checkpoint CRUD 与保留策略。

完成门槛：不接 runtime 的纯单元测试覆盖惰性创建、first-mutation-wins、
last_known 推进、prune。

### C2：捕获路径

1. `CheckpointSink` 接入 registry 与 RuntimeSession turn 边界。
2. Write/Edit 写前捕获、写后推进。
3. 失败矩阵中 capture 相关行的集成测试。

完成门槛：任何 Write/Edit 成功路径都有对应条目；capture 失败时文件零修改；
turn 无变更时无 checkpoint。

### C3：恢复路径

1. `RuntimeSession.restoreCheckpoint()` 四阶段算法。
2. FileSnapshotStore 同步与合成消息注入。
3. `/undo` 命令族、事件、TUI 提示。
4. resume 的 open -> interrupted 处理与 session delete 级联。

完成门槛：第九节失败矩阵全部有测试；`/undo`、`/undo list`、
`/undo <n> [--force]` 手工验收通过。

### C4：收尾

1. PTY journey：多文件 turn 后 `/undo`，再 `/undo` 恢复更早 turn。
2. 公共契约文档更新，`bun run check` 全量通过。
3. 回填本文档实施结果与差异。

## 十四、测试计划

### 14.1 捕获

- turn 内首次 Write 新建文件：`pre_state = absent`，无 blob。
- turn 内两次 Edit 同一文件：仅一条目，pre 为 turn 前内容。
- 同一文件跨两个 turn：两个 checkpoint 各一条目；内容相同时 blob 去重为一份。
- `old_string = ''` 创建与写空文件路径均正确捕获。
- 相对/绝对路径写法归一到同一条目。
- blob 超限、条目超限分别 fast-fail 且文件未修改。
- 只读 turn 不产生 checkpoint。

### 14.2 turn 边界与中断

- completed / failed / cancelled turn 的 checkpoint 均标记 completed 且可恢复。
- 模拟进程中断留下 open checkpoint，resume 后转为 interrupted 且可恢复。
- capture 成功 + writeFile 注入失败：条目 last_known = pre，恢复为 no-op。

### 14.3 恢复

- 修改 + 新建混合 turn 的完整恢复：写回内容、删除新建文件、目录保留。
- drift：恢复前手工改动目标文件 -> 整体拒绝，所有文件未动。
- `--force`：覆盖 drift 文件，且 safety checkpoint 可再次恢复。
- 恢复后 Edit 不需要重新 Read（snapshot 已同步），外部再改动后 Edit 仍被 drift
  检查拦下。
- 恢复后下一模型请求包含注入的合成消息；provider payload 通过协议校验。
- 连续 `/undo` 两个 turn 顺序正确；对已 restored checkpoint 重复恢复幂等。
- Phase 3 单条目注入失败：其余条目完成，报告 skipped 与 safety checkpoint。

### 14.4 生命周期

- `/session delete` 后 blob 与元数据全部移除。
- fork 不继承 checkpoint。
- 超过保留上限后最旧 checkpoint 被 prune，无引用 blob 被回收，仍被引用的保留。
- turn 执行中 `/undo` 被拒绝。

### 14.5 门禁

```bash
bun test src/__tests__/session-schema.test.ts
bun test src/__tests__/session-store.test.ts
bun test src/__tests__/tools.test.ts
bun test src/__tests__/runtime-session.test.ts
bun test src/__tests__/session-resume.test.ts
bun test src/__tests__/slash-commands.test.ts
bun run check
```

## 十五、手工验收

1. 让 agent 在一个 turn 内新建一个文件并修改两个现有文件，其中一个是嵌套新目录。
2. 确认 timeline 显示 `N files changed · /undo to restore`。
3. `/undo list` 确认 checkpoint 条目、turn 号和文件数正确。
4. `/undo`：新建文件被删除，两个文件内容逐字节回到 turn 前；新建文件的空父目录
   保留（文档化行为）。
5. 立即 `/undo` 上一次 restore 的 safety checkpoint（经 `/undo list` 诊断路径），
   确认可反悔。
6. 再让 agent 改同一文件，然后 `/undo` 更早的 turn，确认 drift 拒绝且无部分恢复；
   `--force` 后恢复成功。
7. 修改一个文件后直接退出 TUI，resume 该 session，`/undo` 仍可用。
8. `/session delete` 后确认 `.tinker/sessions/<id>/checkpoints/` 已删除。
9. 检查 events.jsonl 与 observation log，确认 `workspace.restored` 记录完整。

## 十六、关键取舍

1. **turn 聚合而非逐 Edit 快照**：匹配"撤销那次让 agent 干活"的用户语义；单文件
   级细粒度由 drift 报告和 patch 展示补足，不值得为此引入第二条时间线。
2. **capture 先于 mutation 且 fail-closed**：undo 承诺必须可信；宁可让一次写入
   因 checkpoint 不可用而失败，也不让用户在"以为能撤销"的状态下丢失内容。
3. **内容寻址 blob + SQLite 元数据**：正交于账本，去重免费，级联删除简单；不把
   大正文塞进 SQLite 拖慢会话事务。
4. **恢复不动 canonical history**：历史记录事实，checkpoint 管理工作区；模型通过
   合成消息获知回滚，两套语义各归其位。
5. **恢复先捕获 safety checkpoint**：让 `/undo` 自身满足可逆性，force 路径也不
   例外。
6. **drift 默认拒绝而非自动合并**：checkpoint 是状态恢复不是三路合并；冲突时给
   用户完整信息，由人决定。
7. **不捕获 Bash 副作用**：第一版诚实声明边界，用 drift 检测兜底；这比假装能
   拦截任意进程副作用更可信。
