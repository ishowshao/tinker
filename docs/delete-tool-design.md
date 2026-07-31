# Delete 工具设计方案

## 状态

本文定义 `Delete` 工具第一版的确定性契约和实施范围。第一版已按本文契约实施。

## 背景

Tinker 已有 `Read`、`Write` 和 `Edit` 三个基础文件工具，但删除文件仍需要模型通过
`Bash` 调用 `rm`。这会把一个常见、结构化的文件操作降级为自由形式 shell 命令：

- 模型需要自行拼接和转义路径。
- `rm` 的选项面远大于删除单个文件所需的能力。
- 工具结果只能表现为 Bash 命令结果，不能稳定表达删除的目标和失败原因。
- TUI、事件日志和模型 Observation 无法把它识别为明确的文件删除操作。

因此增加一个窄范围的 `Delete` 工具，使模型可以直接删除一个明确的普通文件。

## 目标

- 提供模型可调用的 `Delete(file_path)`。
- 一次调用只删除一个现有普通文件。
- 相对路径沿用 workspace 边界，绝对路径沿用现有文件工具的范围。
- 删除目录、符号链接或其他非普通文件时 fast-fail。
- 文件不存在或删除失败时返回清晰、可纠正的普通工具错误。
- 删除成功后清除该路径在当前 runtime 中可能存在的文件快照。
- TUI、one-shot CLI、事件日志和 Observation 能明确显示删除结果。

## 非目标

- 不支持目录删除，包括空目录。
- 不支持递归删除。
- 不支持 `force`、glob、批量路径或忽略不存在文件。
- 不支持回收站、撤销、备份或自动恢复。
- 不增加用户确认、权限审批或 allow / deny 规则。
- 不使用文件快照或 SHA-256 作为删除授权。
- 不生成文件内容 diff。
- 不改变 `Read`、`Write` 和 `Edit` 的现有快照与并发修改契约。

## 核心语义

### Delete 是路径级操作

`Delete` 的含义是：

> 删除调用执行时位于 `file_path` 的普通文件。

删除意图由路径确定，不依赖文件正文，也不读取或校验当前 runtime 的文件快照。

### 不提供版本保证

第一版不承诺“只删除模型先前观察过的那个内容版本”。如果其他进程在调用前替换了同一路径
的普通文件，`Delete` 仍会删除调用时的文件。

`lstat` 检查和按路径删除之间不存在跨平台的原子“检查类型并删除”接口。实现应让检查尽量
靠近实际删除，但不虚构原子版本保护：

- 路径在检查后消失时，删除失败。
- 路径在检查后变成目录时，无递归的 `rm()` 应失败。
- 路径在检查后变成符号链接时，`rm()` 最多删除该链接本身，不会跟随链接删除目标。
- 路径在检查后被另一个普通文件替换时，新的普通文件可能被删除；这符合路径级契约。

如果未来需要“只删除指定内容版本”，应单独设计显式的 `expected_sha256` 契约。该能力
不属于第一版。

### 文件类型

第一版只接受 `lstat().isFile()` 为真的普通文件。

- 目录返回 `Path is not a regular file.`。
- 符号链接返回 `Symbolic links are not supported.`。
- socket、FIFO、设备文件等其他类型返回 `Path is not a regular file.`。

符号链接被明确排除，因为“删除链接本身”和“删除链接目标”是两种不同语义。第一版不猜测
调用方意图，也不沿符号链接扩大删除范围。

### 文件不存在

文件不存在是普通工具失败，不是幂等成功：

```text
Delete failed for src/obsolete.ts: File does not exist.
```

不提供 `force` 或 `missing_ok` 参数。模型若需要确认当前状态，应使用 `Glob` 或其他现有
工具重新检查。

### 路径范围

`Delete` 复用 `resolveWorkspacePath()`：

- workspace-relative 路径必须位于 workspace 内。
- `..` 导致的相对路径逃逸直接失败。
- 绝对路径继续允许指向 workspace 外，与现有 `Read`、`Write` 和 `Edit` 保持一致。
- 空字符串和纯空白路径直接失败。

本方案不扩大现有文件工具的路径范围。

## Tool Schema

模型可见定义：

```ts
{
  name: "Delete",
  description:
    "Delete one existing regular file. Directories and symbolic links are not supported.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      file_path: {
        type: "string",
        description: "Workspace-relative path or absolute path."
      }
    },
    required: ["file_path"]
  }
}
```

不增加 `recursive`、`force`、`expected_sha256`、`confirm` 或多路径参数。

## 执行流程

新增 `src/tools/delete.ts`，导出：

```ts
createDeleteToolExecutor({
  workspaceRoot,
  snapshots
})
```

执行顺序固定为：

1. 检查取消信号。
2. 校验参数对象和 `file_path`。
3. 通过 `resolveWorkspacePath()` 得到绝对路径。
4. 使用 `lstat()` 读取路径条目类型。
5. 将 `ENOENT` 和父路径 `ENOTDIR` 统一为 `File does not exist.`。
6. 拒绝目录、符号链接及其他非普通文件。
7. 在删除副作用前再次检查取消信号。
8. 调用 `rm(absolutePath)`，不传 `force` 或 `recursive`。
9. 删除成功后执行 `snapshots.delete(absolutePath)`。
10. 返回结构化成功结果。

参数或前置条件失败时不得调用 `rm()`，也不得修改快照。

删除完成后不再检查取消信号。否则可能出现文件已经删除、工具却被报告为普通取消的误导
结果。若进程在副作用期间异常中断，继续沿用 runtime 现有的“副作用状态未知”恢复语义。

### 未来 Undo 接缝

第一版不接入 turn undo，也不为了未来能力提前读取文件正文、注入 undo manager 或扩展
raw result。实现只需保持一个清晰的删除提交点：所有参数、路径和文件类型校验完成后，
由一次 `rm(absolutePath)` 产生删除副作用。

未来若 active runtime 启用 turn undo，应在不改变 Delete 公开契约的前提下围绕该提交点
接入：

```text
校验路径和文件类型
  -> undo manager 捕获删除前的原始 bytes
  -> rm(absolutePath)
  -> undo manager 记录 after = absent
  -> snapshots.delete(absolutePath)
```

捕获内容只属于 active runtime 的内部 undo 状态，不进入 `DeleteFileRawResult`、
Observation、event log 或 canonical history。after 状态、容量限制、同一 turn 内与
Write/Edit 的合并规则以及恢复算法由 undo 方案定义，不在 Delete 第一版中预付实现。

## Raw Result

在 `src/tools/types.ts` 增加：

```ts
export type DeleteFileRawResult = {
  ok: boolean;
  filePath: string;
  absolutePath?: string;
  error?: string;
};
```

并在 `ToolRawResultByKind` 增加：

```ts
delete: DeleteFileRawResult;
```

第一版不返回以下字段：

- `oldSha256`：Delete 不提供内容版本保证。
- `bytesDeleted`：删除前读取的大小可能在真正删除前变化。
- `patch`：生成可靠内容 diff 需要额外读取全文，并暗示工具知道被删除的精确内容版本。
- `deleted: true`：`ok: true` 已经完整表达成功结果。

保持 raw result 最小，可以避免把近似元数据误写成确定事实。

## 文件快照

`Delete` 接收现有 `FileSnapshotStore`，目的仅是清理状态。

- 删除前不读取 snapshot。
- 没有 snapshot 不影响删除。
- snapshot 哈希与磁盘内容是否一致不影响删除。
- 只有 `rm()` 成功后才执行 `snapshots.delete(absolutePath)`。
- 删除失败时保留原 snapshot。

成功删除后必须清除快照。若另一个进程稍后在同一路径创建新文件，旧快照不能被后续
`Write` 或 `Edit` 错误地当成新文件的已知版本。

不为 `FileSnapshot.source` 增加 `"delete"`；删除后没有可记录的当前文件版本。

## Observation

`ObservationBuilder` 增加 `delete` 分支。

成功：

```text
Delete succeeded for src/obsolete.ts.
```

失败：

```text
Delete failed for src/obsolete.ts: File does not exist.
```

```text
Delete failed for scripts: Path is not a regular file.
```

```text
Delete failed for current-config: Symbolic links are not supported.
```

Delete 失败是普通 `ok: false` Observation，不升级为 runtime fatal error。文件系统返回的
其他错误保留底层 detail，便于模型判断权限、只读文件系统或其他 I/O 问题。

## 注册和模型可见契约

在 `createDefaultTooling()` 中把 `Delete` 注册在 `Write`、`Edit` 之后、`Bash` 之前，使
基础文件修改工具保持连续：

```text
Write -> Edit -> Delete -> Bash
```

第一版不修改 runtime instructions。`Delete` 的用途、单文件范围和文件类型限制已经由
tool description 与 schema 完整表达，无需在常驻系统提示中重复。模型仍可根据当前
工具面和具体任务选择 `Delete` 或 `Bash`。

## TUI、stdout 和事件

### TUI

`src/tui/event-store.ts` 的穷尽分支增加 `delete`：

- running 摘要沿用现有 `Delete <path>`。
- 成功摘要显示 `Delete <path> -> deleted`。
- 失败摘要显示现有错误 detail。
- 不附加 diff。

### one-shot stdout

现有 `tool.started` 和 `tool.finished ... ok=<boolean>` 已能表达执行状态。stdout event
printer 只需在穷尽分支中识别 `delete`，第一版不增加专用 raw-result 行或 diff 输出。

### 结构化事件

`tool.raw_result` 持久化完整 `DeleteFileRawResult`；`tool.finished` 和
`tool.observation` 沿用现有通用链路。不增加新的 event type。

## 实施范围

新增：

- `src/tools/delete.ts`

修改：

- `src/tools/types.ts`
- `src/tools/registry.ts`
- `src/observation/observation-builder.ts`
- `src/tui/event-store.ts`
- `src/events/stdout-event-printer.ts`
- `src/session/session-store.ts`（允许恢复时解码 `delete` raw result；不修改 schema）
- `src/__tests__/tools.test.ts`
- 对应的 TUI 和 stdout 测试
- `README.md`
- `docs/observation-current-state.md`

不修改：

- agent loop
- session schema
- provider mapping
- MCP
- `FileSnapshot` 结构
- Bash guard

新增 tool definition 会自然进入当前 tool surface；不为旧 session 增加兼容分支或迁移
逻辑。

## 测试方案

### Schema 和注册

- 默认 registry 包含 `Delete`。
- schema 只有必填的 `file_path`。
- `additionalProperties` 为 `false`。
- 注册顺序位于 `Edit` 之后、`Bash` 之前。

### 成功路径

- 没有文件快照时直接删除 workspace 内普通文件。
- 删除成功后磁盘路径不存在。
- 成功 Observation 为精确的 `Delete succeeded for <path>.`。
- 绝对路径指向 workspace 外普通文件时保持现有文件工具能力。
- 文件有 Read、Write 或 Edit 快照时仍可删除。
- 删除成功后对应 snapshot 被移除。

### 失败路径

- 参数不是对象时失败。
- `file_path` 缺失、非字符串、空字符串或纯空白时失败。
- workspace-relative 路径逃逸时失败。
- 文件不存在时返回 `File does not exist.`。
- 父路径是普通文件时返回 `File does not exist.`。
- 目录删除失败且目录内容不变。
- 空目录同样失败。
- 符号链接删除失败，链接和目标都保持不变。
- FIFO 或其他非普通文件在当前平台可安全构造时失败。
- 权限或其他 `rm()` 错误作为普通工具失败返回。
- 删除失败时已有 snapshot 不被清除。

### 展示和回归

- TUI 成功摘要显示 `-> deleted`，不附加 diff。
- TUI 失败摘要包含错误原因。
- stdout event printer 接受 `delete` raw kind，不产生 diff。
- ObservationBuilder 对 `delete` 做穷尽处理。
- runtime instructions 保持不变。
- 现有 Read、Write、Edit 测试保持不变。

## 验证

实施期间先运行聚焦测试：

```text
bun test src/__tests__/tools.test.ts
bun test src/__tests__/tui-event-store.test.ts
bun test src/__tests__/stdout-event-printer.test.ts
```

最终运行项目完整质量门：

```text
bun run check
```

## 验收标准

- 模型能用一次 `Delete(file_path)` 删除一个现有普通文件。
- 删除不依赖 `FileSnapshotStore` 中已有记录。
- Delete 不具备目录、符号链接、递归、force、glob 或批量删除能力。
- 删除成功后不会留下该路径的陈旧文件快照。
- 工具 description、schema、Observation、TUI 和文档表达同一套语义。
- 所有新增失败都是可继续的普通工具失败。
- `bun run check` 通过。
