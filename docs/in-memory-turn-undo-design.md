# Active Session 内存级 Turn Undo 技术方案

## 文档状态

- 日期：2026-07-31
- 状态：待实施
- 定位：原持久化 checkpoint 方案的精简替代方案
- 前置能力：Write/Edit 快照与 drift 校验、Delete 普通文件删除契约、turn identity、
  turn cancellation、RuntimeSession、TUI session controller

## 一、结论先行

第一版只提供一个窄能力：

> `/undo` 撤销当前 active session 中最近一个尚未撤销、且确实通过
> Write/Edit/Delete 改变过文件状态的 turn；只要任一目标文件发生 drift，就拒绝整个
> 操作。

Undo 状态只保存在当前 `RuntimeSession` 的内存中，不写入 SQLite，不创建 checkpoint
目录，不进入 event log，也不改变 canonical history。因此：

- 不升级 session schema；
- 不影响现有 session 创建、resume、fork、delete 和 schema fingerprint；
- 退出 Tinker、进程崩溃、切换 session、`/clear`、`/fork`、`/model` 或 `/resume`
  后，原 runtime 的 undo 状态立即丢失；
- resume 一个历史 session 时，只能撤销 resume 之后由该次 active runtime 产生的
  Write/Edit/Delete turn；
- 不承诺跨进程恢复，不提供 safety checkpoint、redo、指定 turn、list 或 force。

这个边界是产品语义，不是临时的持久化缺陷。用户若需要跨进程或长期恢复，应使用 Git
或未来另行设计的持久化版本。

## 二、为什么采用内存方案

当前需求的核心价值是让用户在同一次 TUI 工作过程中快速反悔上一轮文件修改。为此没有
必要引入：

- schema v10 和 migration/cutover；
- SQLite checkpoint 表；
- 内容寻址 blob 目录；
- safety checkpoint 和第二条恢复时间线；
- blob prune、引用统计和孤儿回收；
- resume 中断恢复；
- canonical runtime 合成消息；
- `workspace.restored` 的多 sink 事件投影。

Write/Edit 在写盘前已经读取目标文件，Delete 也有明确的单文件 `rm()` 提交点，tool call
已携带完整 turn identity，RuntimeSession 又天然随 active session 创建和销毁。因此
最小实现可以直接在 tooling 旁边维护一个有界的内存 undo 栈；Delete 只在启用 undo 的
runtime 中于提交前额外读取原始字节。

## 三、用户可见语义

### 3.1 唯一命令

```text
/undo
```

首版不接受任何参数：

```text
/undo list
/undo 7
/undo --force
```

以上都返回稳定的 usage 错误：

```text
Usage: /undo
```

`/undo` 不是模型工具，模型不能主动调用。

### 3.2 选择规则

Undo manager 按 turn 完成顺序维护 checkpoint 栈。`/undo` 只选择栈顶，也就是：

1. 当前 active runtime 内最近完成的；
2. 至少有一次被 manager 确认为已发生的 Write/Edit/Delete mutation；
3. 最终文件的存在状态或内容相对 turn 前确实发生变化；
4. 尚未成功撤销的 turn。

恢复成功后弹出栈顶。再次执行 `/undo` 时，选择再前一个尚未撤销的
Write/Edit/Delete turn。

以下 turn 不进入 undo 栈：

- 只有 Read/Grep/Glob/Recall/Web/Bash/MCP 的 turn；
- Write/Edit/Delete 在文件副作用前失败、没有产生文件变化的 turn；
- 最终文件存在状态及内容与 turn 前逐字节相同的 turn，例如本轮创建后又删除同一文件。

turn 最终是 `completed`、`failed` 或 `cancelled` 不影响资格：只要 manager 能确认
Write/Edit/Delete 已经改变文件状态，该 turn 在正常收尾后即可撤销。runtime 发生 fatal
fault 时不再承诺可以继续执行 `/undo`。

### 3.3 生命周期

Undo 栈严格绑定某一个 active `RuntimeSession` 实例：

| 操作 | Undo 状态 |
| --- | --- |
| 同一 active session 中完成下一 turn | 保留 |
| 同一 active session 中 `/compact`、`/compact retire` | 保留 |
| `/undo` 成功 | 弹出最近 checkpoint |
| `/clear` | 丢失 |
| `/fork` | 原 session 与 fork session 都不继承旧 runtime 的 undo 栈 |
| `/model` | 丢失 |
| 切换到其他 session | 丢失 |
| `/resume` 当前或历史 session | 新 runtime 从空栈开始 |
| 正常退出、崩溃、强制结束进程 | 丢失 |

TUI 不宣称这些状态可恢复，也不在 `/resume` 界面显示 undo 能力。

### 3.4 成功与失败提示

成功示例：

```text
Restored workspace to before turn 7: 2 files restored, 1 file deleted.
```

没有可撤销 turn：

```text
Nothing to undo in this active session.
```

发生 drift：

```text
Undo refused: 2 files changed after turn 7.
- src/a.ts: content changed
- src/b.ts: expected file, found missing
```

drift 拒绝必须发生在任何恢复写盘之前。

若预检通过后发生真实 I/O 失败，结果明确说明已经完成的部分和失败路径：

```text
Undo incomplete for turn 7: restored 1 file before src/b.ts failed: <detail>.
Run /undo again to retry.
```

这不是 drift 路径的部分恢复；文件系统不提供跨多文件事务，I/O 失败只能通过幂等重试
收敛。

## 四、目标与非目标

### 4.1 目标

1. turn 内同一文件只保留第一次成功修改或删除之前的状态。
2. pre-turn 状态必须在第一次可能写盘或删除前进入内存；捕获失败则本次
   Write/Edit/Delete 不产生文件副作用。
3. 同一文件在 turn 内经过任意 Write/Edit/Delete 组合后，记录最后一次成功 mutation
   的状态；它可以是带 SHA-256 的 present，也可以是 absent，并作为 undo drift 基准。
4. `/undo` 只恢复最近一个尚未撤销的有效 checkpoint。
5. 任一条目 drift 时，在零文件修改的前提下整体拒绝。
6. 恢复过程可幂等重试；进程内发生部分 I/O 失败时，不需要 safety checkpoint。
7. 恢复尝试修改过的路径从 `FileSnapshotStore` 清除，强制后续 Write/Edit 重新 Read。
8. 内存使用有固定上限，旧 checkpoint 可以按明确规则淘汰。

### 4.2 非目标

第一版不做：

- checkpoint 持久化、schema 变更或 session resume 恢复；
- Bash、MCP、外部进程或用户手工文件操作的捕获；
- `/undo list`、指定 turn、范围 undo 或 `--force`；
- safety checkpoint、redo 或撤销 `/undo`；
- 跨 session 协调；
- 目录快照、空父目录删除、权限/owner/xattr 恢复；
- Git 集成；
- 二进制写入工具；只保护现有 Write/Edit/Delete 对普通文件的副作用；
- canonical history 注入或 provider request 特判；
- 新增持久事件类型、JSONL/observation log/stdout event；
- one-shot CLI 的 `/undo` 入口。

## 五、必须保持的不变量

```text
active-runtime-only：
  checkpoint 只属于创建它的 RuntimeSession 实例

first-successful-mutation-wins：
  同一 turn/path 的 before 状态是第一次成功 Write/Edit/Delete 紧邻之前的文件状态

capture-before-mutation：
  before 状态进入内存前，Write/Edit 不得开始 writeFile，Delete 不得开始 rm

latest-successful-state：
  expectedAfter 只在 mutation 的结果状态已成立后推进；Write/Edit 记录验证后的
  present SHA-256，Delete 在 rm 成功后记录 absent

latest-only：
  /undo 只能选择 undo 栈顶

drift-fails-closed：
  任一目标既不等于 expectedAfter，也不等于一次未完成恢复中的 before 时，
  整个预检失败且零写盘

consume-after-verification：
  所有目标都验证为 before 状态后，checkpoint 才从栈中移除

no-history-rewrite：
  undo 不修改 canonical message、frame、turn、iteration 或 context revision
```

## 六、内存数据模型

新增 `src/tools/turn-undo-manager.ts`，只维护普通 TypeScript 对象，不访问
`SessionStore`：

```ts
type CapturedFileState =
  | { state: "absent" }
  | {
      state: "present";
      bytes: Buffer;
      sha256: string;
      byteLength: number;
    };

type FileStateFingerprint =
  | { state: "absent" }
  | { state: "present"; sha256: string };

type TurnUndoEntry = {
  absolutePath: string;
  displayPath: string;
  before: CapturedFileState;
  expectedAfter?: FileStateFingerprint; // undefined only while provisional
  mutationCount: number;
};

type TurnUndoCheckpoint = {
  turnId: TurnId;
  turnNumber: number;
  entries: Map<string, TurnUndoEntry>; // key = normalized absolutePath
  retainedBytes: number;
  completed: boolean;
};
```

`before.bytes` 使用从 `readFile()` 得到的原始字节副本，不从 UTF-8 `oldContent` 反向编码，
避免旧文件包含非规范 UTF-8 字节时无法逐字节恢复。Write/Edit 仍使用现有字符串语义
计算新内容和 patch。Delete 捕获的 bytes 只进入 manager，不进入 raw result、Observation、
event log 或 canonical history，也不把 Delete 的公开路径级语义改成内容版本授权。

`expectedAfter` 只保存恢复前应看到的存在状态和内容指纹，不保存 after bytes。Delete 成功
后的值是 `{ state: "absent" }`；Write/Edit 成功后的值是
`{ state: "present", sha256 }`。

不存在单独的 checkpoint ID、restore status、safety kind 或 per-entry restore state。
栈中存在即表示尚未成功撤销；成功后直接移除。

### 6.1 固定容量

第一版使用代码常量，不新增配置项：

```text
单文件 before 内容上限：32 MiB
单 active runtime undo 内容总上限：64 MiB
最多保留：20 个已完成 checkpoint
```

捕获新文件状态前，manager 先从最旧的已完成 checkpoint 开始淘汰，直到满足 turn 数量
和总字节上限。当前仍在执行的 turn checkpoint 不参与淘汰。

若清空所有旧 checkpoint 后，当前 turn 自身仍会超过 64 MiB 或单文件超过 32 MiB，
本次 Write/Edit/Delete fast-fail，文件不被修改或删除。错误明确说明 undo 内存上限，
而不是伪装成普通文件 I/O 错误。

创建文件的 `before = absent` 不占内容字节，只占普通对象开销。

Delete 第一次修改某路径时同样受 32 MiB 单文件限制，因为撤销删除必须保留完整原始
bytes。Delete 已通过 `lstat()` 取得文件大小，可以在分配大 Buffer 前拒绝明显超限的
文件；最终仍以实际读取的 byte length 为准。同 turn/path 已有成功 mutation 时 before
已经固定，后续 Delete 不重复计入或替换这份内容。

## 七、捕获路径

### 7.1 复用现有 ToolCall identity

`ToolExecutor.execute(args, call, context)` 的 `call` 已经包含 `turnId` 和
`turnNumber`。Write/Edit/Delete 当前都把它命名为 `_call`，实施时直接使用该 identity：

```ts
await undoManager.captureBeforeMutation({
  turnId: call.turnId,
  turnNumber: call.turnNumber,
  absolutePath,
  displayPath,
  loadBefore: async () => before,
});
```

`loadBefore` 采用惰性回调：没有 entry 或 entry 仍是 provisional 时 manager 才调用它；
同 turn/path 已有成功 mutation 时直接 no-op。Write/Edit 的回调只返回工具已经读取的
current state；Delete 的回调才执行容量预检与 `readFile()`。这样后续 Delete 不会为了
一份已经固定的 before 再读取可能很大的当前文件。

因此不扩展 `ToolExecutionContext`，不增加全局 current turn，也不需要
`CheckpointSink.beginTurn()`。

TUI runtime 创建时显式传入 `enableTurnUndo: true`。RuntimeSession 据此让
`createDefaultTooling()` 创建一个 session 级 `TurnUndoManager`，与 `snapshots` 一样
随 tooling/runtime 生命周期存在，并注入 Write/Edit/Delete executor options。
`DefaultTooling` 把可选 manager 暴露给 RuntimeSession，但不暴露为模型工具。

one-shot runner 不传该开关，Write/Edit/Delete 不捕获 undo 状态，也不因 undo 内存上限
改变原有行为；尤其 Delete 继续只做现有 `lstat()` + `rm()`，不额外读取正文。测试若要
覆盖 undo，必须显式启用，避免默认改变所有 RuntimeSession fixture。

### 7.2 provisional capture

“副作用前捕获”与“第一次成功 mutation”之间可能存在 I/O 失败，因此 entry 在第一次
成功 mutation 前是 provisional：

1. 第一次尝试修改或删除某路径时，在 `writeFile()` / `rm()` 前保存当前状态。
2. 如果该路径尚无成功 mutation，后续重试可以用当时最新状态替换 provisional before。
3. mutation 的结果状态成立后调用 `recordMutationResult()`，`mutationCount` 变为 1；
   此后同 turn 对该路径的 capture 都是 no-op，只推进 `expectedAfter`。
4. turn 收尾时删除 `mutationCount = 0` 的 provisional entry。

这样 capture 成功但 `writeFile()` / `rm()` 在真正产生副作用前失败，不会把一次未发生
的尝试误当成 turn 的 first mutation。

### 7.3 Write 顺序

```text
解析路径
  -> targetFileState() 取得当前 bytes/content/hash
  -> 现有 Read snapshot/drift 校验
  -> undoManager.captureBeforeMutation(call identity, current state)
  -> ensureParentDirectory()
  -> writeFile()
  -> stat/read-back 验证新内容 hash
  -> undoManager.recordMutationResult(path, present + new hash)
  -> FileSnapshotStore.set(...)
  -> 返回现有 Write result
```

capture 必须在 `ensureParentDirectory()` 之前，避免 undo 内存上限失败时仍创建目录。

### 7.4 Edit 顺序

普通 Edit 保留现有第二次 target state 校验。只有校验通过、已经得到将要提交的
`newContent` 后才 capture：

```text
解析路径并读取目标
  -> 现有 snapshot、match、replace_all 校验
  -> writeEditedContent() 中再次验证 expectedSha256
  -> undoManager.captureBeforeMutation(call identity, verified current state)
  -> 创建模式下 ensureParentDirectory()
  -> writeFile()
  -> stat/read-back 验证新内容 hash
  -> undoManager.recordMutationResult(path, present + new hash)
  -> FileSnapshotStore.set(...)
```

`old_string = ""` 创建文件时保存 `before = absent`；写入已存在空文件时保存
`before = present` 和零字节 Buffer，两者不能混淆。

### 7.5 Delete 顺序

Delete 保持现有路径级语义，不要求已有 Read snapshot，也不把捕获到的 hash 当作删除
授权。只有 active runtime 启用 undo 且该 turn/path 尚未完成第一次 mutation 时，才为
内部 checkpoint 读取正文：

```text
解析路径
  -> lstat() 并完成现有普通文件、非符号链接校验
  -> undoManager.captureBeforeMutation(call identity, lazy loader)
       -> 若需要 before，根据 lstat.size 预检单文件容量
       -> readFile() 取得当前原始 bytes/hash
  -> 再次检查 turn cancellation
  -> rm()
  -> undoManager.recordMutationResult(path, absent)
  -> FileSnapshotStore.delete(...)
  -> 返回现有 Delete result
```

若该 turn/path 已有成功 mutation，before 已经固定，Delete 不需要再次读取或计入当前
正文；它只在 `rm()` 成功后把 `expectedAfter` 推进为 absent。首次捕获时若文件不可读、
超过容量或读取失败，Delete 在 `rm()` 前 fast-fail。这个额外限制只存在于显式启用 undo
的 active TUI runtime；one-shot 的 Delete 公开契约不变。

`rm()` resolve 即表示删除提交点已经成功，不需要为了记录 absent 再读取路径。若另一个
进程随后在同一路径创建文件，`/undo` 预检会把它识别为 drift。捕获正文与按路径 `rm()`
之间仍不存在跨平台原子版本保证，这继承 Delete 的既有路径级并发语义；本方案不为此
增加 `expected_sha256` 或文件锁。

### 7.6 同一路径的混合 mutation

manager 不按工具分别建 entry，而是统一使用“第一次成功 mutation 前的 before”和
“最后一次成功 mutation 后的 expectedAfter”。因此同一 turn 内必须满足：

- `Delete -> Write`：before 是删除前原文件，expectedAfter 是最后写入的 present hash；
  undo 恢复原文件。
- `Write/Edit -> Delete`：before 仍是 turn 前状态，expectedAfter 是 absent；undo 按需
  恢复 turn 前文件。
- 创建文件后再 Delete：before 和 expectedAfter 都是 absent，turn 收尾时作为净 no-op
  删除 entry。
- Delete 后又写回与原始 bytes 完全相同的内容：before 与 expectedAfter 相同，同样作为
  净 no-op 删除 entry。

### 7.7 文件副作用异常

Write/Edit 的 `writeFile()` 或 Delete 的 `rm()` 抛错后，都应重新读取目标的存在状态和
内容指纹：

- 若仍与 provisional before 一致，保留 provisional，turn 收尾时自然丢弃；同 turn
  重试时允许刷新它；
- 若文件已经变化，说明文件调用虽然抛错但可能产生了副作用，manager 把实际可观察的
  present/absent 状态记录为一次 mutation，使 `/undo` 仍能保护原内容；
- 若无法判断当前状态，工具报告原始 I/O 错误，并将该 entry 标为不可安全恢复；
  turn 收尾时不把含不确定 entry 的 checkpoint 放入 undo 栈。

工具对模型仍报告原始 I/O 失败；状态对账只服务于内部 undo。这里不声称单文件写入或
删除是文件系统事务，只保证 manager 不把已知不完整状态宣传为可撤销。

## 八、Turn 收尾

RuntimeSession 在正常 terminal result 已经落账后调用：

```ts
undoManager.completeTurn(turn);
```

`completeTurn()`：

1. 删除所有没有成功 mutation 的 provisional entry；
2. 比较 before 的 fingerprint 与 `expectedAfter`，删除 present/hash 相同或
   absent/absent 的净 no-op entry；
3. 若没有剩余 entry，删除整个 checkpoint；
4. 否则标记 completed，并放入 undo 栈末尾；
5. 按固定容量淘汰最旧 checkpoint。

`completed`、`failed`、`cancelled` 的 `RunAgentResult` 都走相同收尾。取消不会自动
undo，保持 turn cancellation “不回滚已完成副作用”的既有语义。

若 RuntimeSession 进入 fatal fault，manager 随 runtime 一起失效，不增加恢复分支。

## 九、恢复算法

### 9.1 前置条件

`RuntimeSession.undoLatestFileMutationTurn()` 只在以下条件同时满足时执行：

- runtime state 是 `ready`；
- 没有 active turn；
- 没有 context operation；
- 没有 running/stopping background Bash task；
- undo 栈非空。

后台任务必须停止后才能 undo，因为它可能在 drift 预检之后继续修改目标文件。
用户进程和其他 Tinker session 仍可能产生竞态；第一版不尝试建立跨进程文件锁。

### 9.2 Phase 1：完整预检

读取栈顶 checkpoint 的所有路径，并分类：

```text
fingerprint(current) == expectedAfter       -> pending restore
fingerprint(current) == fingerprint(before) -> already restored（前一次 I/O 失败后的重试）
otherwise                                  -> drift conflict
```

比较规则同时覆盖存在状态和内容 hash：

- 当前 missing：可以匹配 `expectedAfter = absent`（Delete 后待恢复），也可以匹配
  `before = absent`（撤销创建已经完成）；否则冲突；
- 当前路径不是普通文件：冲突；
- present 状态必须计算当前字节 sha256，不能只比较 mtime。

收集全部 conflict 后一次性返回。只要 conflict 非空，Phase 2 不开始，所有文件保持
不动。首版没有 `--force` 绕过。

### 9.3 Phase 2：确定性应用

按 `absolutePath` 排序，依次处理 pending entry：

- `before = absent`：`unlink()` 当前文件；
- `before = present`：把内存中的原始 bytes 写回原路径，再读取并验证 sha256。

已经处于 before 的 entry 是幂等 no-op。删除 turn 创建的文件后不删除空父目录。

每成功处理一个路径，立即从 `FileSnapshotStore` 删除该绝对路径。后续模型若要再次
修改恢复后的现有文件，必须重新 Read，避免依据 canonical history 中已经被撤销的内容
盲写。

### 9.4 I/O 失败与重试

应用阶段遇到第一个 I/O 失败后停止，不继续修改后续路径：

- 已恢复路径保持 before；
- 尚未处理路径保持 `expectedAfter` 对应的 present/absent 状态；
- checkpoint 留在栈顶；
- 所有已经尝试修改的路径从 snapshot store 清除；
- TUI 报告部分结果并提示再次运行 `/undo`。

下一次 `/undo` 的预检同时接受 before 和 `expectedAfter`，因此可以跳过已完成路径
并继续。只有全部 entry 最终都验证为 before，checkpoint 才从栈顶弹出。

这提供进程内幂等重试，但不提供崩溃恢复：进程退出后内存 checkpoint 消失，用户必须
通过 Git、备份或手工方式处理可能的部分状态。

## 十、Canonical history 与模型认知

`/undo` 不修改 canonical history。历史仍如实记录模型曾调用 Write/Edit/Delete 以及
当时的 tool result。

第一版也不插入 runtime user message，因为当前协议要求 user message 绑定真实 turn 且
`origin = "user"`；为 undo 特判协议会扩大本方案范围。

降低模型误用旧状态的措施只有一个：恢复涉及的 snapshot 全部清除，后续 Write/Edit
必须重新 Read。TUI notice 只面向用户，不进入下一次 provider request。

如果未来证据表明模型必须主动获知 `/undo`，应独立设计一种协议合法、可持久化和可
resume 的 workspace-state notice，而不是在本功能中伪造 canonical user message。

## 十一、TUI 接缝

### 11.1 Slash command

`src/tui/slash-commands.ts` 增加：

```ts
{ name: "undo", usage: "/undo", description: "Undo the latest Write/Edit/Delete turn" }
```

解析结果只增加：

```ts
{ type: "undo" }
```

任何额外 token 都返回 `Usage: /undo`。

### 11.2 Session controller

`TuiSessionController` 增加：

```ts
undo(): Promise<TurnUndoResult>;
```

`DefaultTuiSessionController.undo()` 复用现有 `serialize()`，调用当前 binding 的
`runtimeSession.undoLatestFileMutationTurn()`。`serialize()` 只负责阻止另一个 session
operation 并发；runtime 自己负责 ready/background-task 前置条件。

### 11.3 App notice

`src/tui/app.tsx` 把 result 格式化为本地 notice。首版：

- 不新增 timeline item；
- 不修改 turn terminal detail；
- 不新增 `workspace.restored` event；
- 不写 JSONL、observation log 或 stdout event；
- 不显示每个 turn 后的 `N files changed` 提示。

原因是 undo 状态本身不持久化，持久事件却会在 resume 后留下无法重建、无法继续操作的
半套事实。

## 十二、代码落点

| 文件 | 主要变更 |
| --- | --- |
| `src/tools/turn-undo-manager.ts` | 新增有界内存 undo 栈、capture、complete、drift preflight、restore |
| `src/tools/write.ts` | 使用 ToolCall identity，写前 capture，写后记录 present expectedAfter |
| `src/tools/edit.ts` | 使用 ToolCall identity，二次校验后 capture，写后记录 present expectedAfter |
| `src/tools/delete.ts` | 在 `rm()` 前惰性捕获原始 bytes，成功后记录 absent expectedAfter |
| `src/tools/registry.ts` | 创建 manager，注入 Write/Edit/Delete，并通过 DefaultTooling 暴露给 runtime |
| `src/tools/types.ts` | FileSnapshot source 不变；无需扩展 ToolExecutionContext |
| `src/agent/runtime-session.ts` | turn terminal 时 complete；新增 undoLatestFileMutationTurn() |
| `src/cli/tui-runner.tsx` | 创建 TUI runtime 时显式启用内存 undo |
| `src/tui/slash-commands.ts` | 只解析无参数 `/undo` |
| `src/tui/tui-session-controller.ts` | serialize() 分发 undo |
| `src/tui/app.tsx` | 显示成功、无可撤销项、drift、I/O partial notice |
| `src/__tests__/turn-undo-manager.test.ts` | 内存领域逻辑 |
| 现有 tools/runtime/TUI/PTY 测试 | 集成与用户路径 |

明确不修改：

- `src/session/session-schema.ts`
- `src/session/session-store.ts`
- session schema/fingerprint 测试
- resume projector
- context compiler/revision
- event type 与 event sinks
- public 持久化配置契约

## 十三、测试计划

### 13.1 内存领域层

- 同 turn 第一次成功 mutation 保存 before，后续 Write/Edit/Delete 只推进 expectedAfter。
- provisional capture 后文件副作用未发生，turn 完成时不产生 checkpoint。
- provisional 重试在首次成功 mutation 前刷新 before。
- 创建文件保存 absent；空文件保存 present + zero-byte Buffer。
- present/hash 相同与 absent/absent 两类净 no-op 都不进入栈。
- 同路径 `Delete -> Write`、`Write/Edit -> Delete` 保留同一 before 并记录最终 expectedAfter。
- completed/failed/cancelled turn 只要有成功 mutation 都进入栈。
- 超过 20 turn 淘汰最旧 checkpoint。
- 超过 64 MiB 时先淘汰最旧；当前 turn 自身仍超限则 capture 拒绝。
- 单文件超过 32 MiB 时 capture 拒绝且未调用 `writeFile()` / `rm()`。

### 13.2 Write/Edit/Delete 集成

- Write 修改现有文件后 `/undo` 恢复原始字节。
- Write 创建文件后 `/undo` 删除文件但保留父目录。
- Edit 同 turn 两次修改同一文件，只恢复到 turn 前。
- Delete 不依赖已有 snapshot，删除后 `/undo` 逐字节恢复原文件。
- Delete capture 容量或读取失败时不调用 `rm()`，原文件与已有 snapshot 都保持不变。
- `rm()` 失败且文件未变化时不产生 checkpoint；若对账确认路径已变成 absent，则仍保留
  可撤销 mutation。
- 同 turn 创建后 Delete 不产生 checkpoint；Delete 后 Write 恢复到删除前原文件。
- Write/Edit 后 Delete 恢复到 turn 前状态，而不是 Delete 紧邻之前的状态。
- 一个 turn 修改多个文件，只产生一个 checkpoint。
- Write/Edit/Delete 前置校验失败不产生 checkpoint。
- capture 容量失败时文件和父目录均未变化。
- Write/Edit 后 manager 的 expectedAfter 是实际 present hash；Delete 后是 absent。

### 13.3 Drift

- 当前内容被用户修改：`/undo` 整体拒绝。
- 预期存在但被删除：整体拒绝。
- Delete 后预期不存在但路径被重新创建：整体拒绝。
- 预期文件被替换成目录：整体拒绝。
- 多文件只有一个 drift：其余文件也不得恢复。
- 后台 Bash running/stopping 时 `/undo` 拒绝。

### 13.4 恢复与重试

- 修改或删除的文件写回 before bytes，新建文件被删除。
- 恢复成功后 checkpoint 弹栈，下一次 `/undo` 选择更早 turn。
- 中途第一个 I/O 失败后停止，checkpoint 保留。
- 重试时已处于 before 的条目跳过，其余条目按 expectedAfter 继续。
- 全部验证为 before 后才消费 checkpoint。
- 成功或部分恢复涉及的 snapshots 被清除，后续 Edit 要求重新 Read。

### 13.5 生命周期

- `/compact` 后 undo 栈仍在。
- `/clear` 后新 runtime 没有旧 checkpoint。
- `/fork` 后目标 runtime 没有旧 checkpoint。
- 切换 session 再 resume 原 session，undo 栈为空。
- 退出并重新启动后 `/resume`，undo 栈为空。
- one-shot runner 不提供 `/undo`，Write/Edit/Delete 也不捕获或额外读取 undo 状态。

### 13.6 TUI 与 PTY

- `/undo extra` 返回 `Usage: /undo`。
- active turn、context operation 或后台任务期间命令被拒绝。
- 成功、empty、drift、partial notice 文案稳定。
- PTY journey：一个 turn 修改文件、创建文件并 Delete 另一个文件，`/undo` 后逐字节验证。
- PTY journey：连续两个修改 turn，连续两次 `/undo` 按倒序恢复。
- PTY journey：修改后手工制造 drift，确认零文件被恢复。

## 十四、实施顺序

### U1：内存领域层

1. 实现 `TurnUndoManager` 和结果类型。
2. 覆盖容量、first-successful-mutation-wins、no-op 清理和幂等恢复。

完成门槛：领域测试不依赖 SessionStore、event sink 或 TUI。

### U2：Write/Edit/Delete 与 RuntimeSession

1. registry 创建并注入 manager。
2. Write/Edit/Delete 接入 capture/record。
3. RuntimeSession terminal 路径调用 complete。
4. RuntimeSession 提供 latest-only undo。

完成门槛：工具与 runtime 集成测试证明 capture-before-mutation、drift 零写盘和连续
undo。

### U3：TUI

1. 增加 `/undo` 解析。
2. controller serialize 分发。
3. App notice。
4. PTY journey 与公共 slash command 文档同步。

完成门槛：真实 TUI 可以完成多文件 turn 的 latest-only undo，session 切换后明确为空。

## 十五、验证门禁

迭代时运行聚焦测试和快速门禁：

```bash
bun test src/__tests__/turn-undo-manager.test.ts
bun test src/__tests__/tools.test.ts
bun test src/__tests__/runtime-session.test.ts
bun test src/__tests__/slash-commands.test.ts
bun run check:fast
```

该变更包含 source code 和 PTY 用户路径，完成前必须运行：

```bash
bun run check
```

## 十六、验收标准

1. 当前 active TUI session 内，一个 turn 通过 Write/Edit/Delete 改变多个文件后，
   `/undo` 恢复被修改或删除文件的 turn 前内容，并删除该 turn 创建的文件。
2. 同一文件在一个 turn 内经过任意 Write/Edit/Delete 组合，只恢复到 turn 开始前；
   净状态未变化时不产生 checkpoint。
3. 任一目标发生 drift 时，所有目标保持不动且列出冲突。
4. 恢复成功后再次 `/undo` 选择更早的未撤销 Write/Edit/Delete turn。
5. `/undo` 没有参数变体、force、list、redo 或模型工具入口。
6. session schema、SQLite 内容和 schema fingerprint 无变化。
7. 切换、退出或 resume 后旧 undo 栈不可用，TUI 返回
   `Nothing to undo in this active session.`。
8. 恢复后相关 snapshot 被清除，模型必须重新 Read 才能继续 Edit。
9. 完整 `bun run check` 通过。

## 十七、关键取舍

1. **只做 active runtime**：换取零 schema、零 migration、零磁盘生命周期；明确放弃
   resume 后 undo。
2. **latest-only 命令**：用栈自然支持连续倒序 undo，不暴露任意历史选择与依赖冲突。
3. **无 force**：drift 表示 checkpoint 已无法证明覆盖安全，应停下来而不是增加危险
   分支。
4. **无 safety/redo**：恢复前完整预检，恢复中用 before/expectedAfter 双状态实现
   幂等重试；不为未提供的 redo 预付第二条时间线。
5. **不注入 canonical history**：保持协议边界不变；通过清除 snapshot 强制重新 Read。
6. **不新增持久事件**：内存能力不留下 resume 后无法兑现的持久投影。
7. **原始字节保存在内存**：即使 Write/Edit 面向文本、Delete 只公开路径级操作，undo
   仍逐字节恢复被覆盖或删除的旧文件。
