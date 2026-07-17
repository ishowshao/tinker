# Write / Edit 自动创建父目录设计

## 状态

本文冻结 `Write` 和 `Edit` 在创建文件时自动创建父目录的目标语义，供后续实施使用。
当前阶段只确定方案，不修改运行时代码。

## 背景

当前 `Write` 和 `Edit` 都会在处理目标文件前检查父目录。只要父目录不存在，工具就
立即失败，并向模型返回：

```text
Parent directory does not exist.
```

模型必须先通过 `Bash` 执行 `mkdir`，再重试文件工具。目录创建本来就是创建文件的
自然组成部分，把它暴露成额外的模型操作会增加一次失败、一次纠正和一次工具调用。

另一方面，不能简单地让所有 `Edit` 调用先执行递归建目录。普通 `Edit` 是对现有文件
做精确字符串替换；如果目标文件不存在，即使创建父目录也无法完成编辑，只会在失败后
遗留无意义的空目录。

## 目标

- `Write` 创建文件时自动递归创建缺失的父目录。
- `Edit` 通过 `old_string=""` 创建文件时自动递归创建缺失的父目录。
- 普通 `Edit` 编辑不存在的文件时不产生目录副作用。
- 保留现有路径解析、Read 快照、mtime、防陈旧写入和精确字符串替换契约。
- 目录无法创建时，在写文件之前 fast-fail，并向模型反馈接近错误来源的原因。

## 非目标

- 不改变相对路径和绝对路径的现有授权范围。
- 不改变 `Write` 修改现有文件前必须有有效 Read 快照的规则。
- 不改变 `Edit` 的 Read 前置条件、mtime 检查或匹配规则。
- 不为目录创建增加单独的工具参数、确认流程或兼容开关。
- 不在成功结果中增加 `createdDirectories` 等新字段。
- 不让普通 `Edit` 隐式退化成创建文件或完整覆盖文件。

## 确定语义

### Write

`Write` 的完整行为如下：

1. 校验参数并解析目标路径。
2. 读取目标文件状态。
3. 如果目标文件已经存在，执行现有 Read 快照和内容陈旧检查。
4. 所有写入前置条件通过后，递归创建缺失的父目录。
5. 写入完整文件内容，并按现有规则更新快照和 patch 结果。

创建新文件时，以下调用应直接成功，不再要求模型先调用 `Bash`：

```text
Write(file_path="src/generated/api/client.ts", content="...")
```

即使 `src/generated/api/` 全部不存在，工具也应创建这些目录后写入文件。

父目录创建应尽量靠近实际 `writeFile`，不要在参数非法、路径非法或现有文件的 Read
前置条件尚未通过时提前产生目录副作用。

### Edit

`Edit` 保留两种明确模式。

普通精确替换模式：

```text
old_string != ""
```

- 目标文件必须存在。
- 目标文件不存在时返回 `File does not exist.`。
- 即使父目录也不存在，也不创建目录，因为本次 Edit 不可能成功。

创建或填写空文件模式：

```text
old_string == ""
```

- 目标文件不存在时，递归创建缺失的父目录，然后创建文件。
- 目标文件是空文件时，保持现有行为，直接写入 `new_string`。
- 目标文件是非空文件时，保持现有拒绝行为：

  ```text
  old_string='' can only create a file or write to an empty file.
  ```

因此，只有实际进入创建文件路径的 `Edit` 才会自动创建父目录。

### 路径范围

自动建目录遵循 `resolveWorkspacePath()` 的现有结果：

- workspace-relative 路径仍必须留在 workspace 内。
- 现有工具允许的绝对路径继续允许指向 workspace 外。
- 相对路径和绝对路径在父目录创建行为上保持一致，避免形成模型难以预测的两套语义。

本方案不扩大可解析路径的范围，只让已经允许写入的目标路径可以同时创建其父目录。

### 失败行为

父目录创建使用递归语义，等价于：

```ts
await mkdir(path.dirname(absolutePath), { recursive: true });
```

以下情况仍应失败：

- 某一级父路径已经是普通文件。
- 当前进程没有创建目录的权限。
- 文件系统只读、空间不足或返回其他 I/O 错误。

失败结果继续作为普通工具失败反馈给模型，不升级为 runtime fatal error。错误文本应明确
指出父目录创建失败，并保留底层错误信息，例如：

```text
Write failed for src/generated/api/client.ts: Failed to create parent directory: <detail>
```

不要再把所有 `stat` 或目录访问错误统一误报成 `Parent directory does not exist.`。

## 实现方案

### 共享 helper

在 `src/tools/` 中增加一个小型共享 helper，职责仅限于为目标文件确保父目录存在，例如：

```ts
async function ensureParentDirectory(filePath: string): Promise<void>
```

helper 内部从绝对文件路径取得 `path.dirname(filePath)`，再调用递归 `mkdir`。失败时保留
原始错误原因，由调用方转成各自的 `WriteFileRawResult` 或 `EditFileRawResult`。

不把这个 helper 放入 `path-safety.ts`。路径安全负责解析和限制路径；创建目录是文件
系统副作用，应保持职责分离。

### Write 改动

在 `src/tools/write.ts` 中：

- 删除执行开头的 `directoryExists()` 检查。
- 保留 `targetFileState()` 和现有 Read 快照检查顺序。
- 在最终 `writeFile()` 前调用 `ensureParentDirectory()`。
- 删除文件内不再使用的 `directoryExists()`。
- 父目录创建失败时返回 `ok: false`，不抛出普通可恢复 I/O 错误。

### Edit 改动

在 `src/tools/edit.ts` 中：

- 删除执行开头的 `directoryExists()` 检查。
- 先通过 `targetFileState()` 判断目标文件是否存在。
- 普通替换遇到不存在的目标文件时，直接返回 `File does not exist.`，不创建目录。
- `old_string=""` 且目标不存在时，在最终写入前调用
  `ensureParentDirectory()`。
- 删除文件内不再使用的 `directoryExists()`。

目录创建应放在写入提交路径，而不是放在 `parseEditArgs()`、路径解析或普通 Edit 的
校验路径中。

### 模型可见描述

更新 `Write` tool description，明确创建文件时会自动创建缺失的父目录。

更新 `Edit` tool description，明确：

- 它默认用于现有文件的精确字符串替换。
- `old_string=""` 可以创建文件或写入空文件。
- 创建文件时会自动创建缺失的父目录。

`src/cli/config.ts` 中的系统提示只需同步这项稳定语义，不要求模型为了建目录预先使用
`Bash`。

`ObservationBuilder` 的成功输出不需要变化。失败时继续使用现有的：

```text
Write failed for <path>: <error>
Edit failed for <path>: <error>
```

## 测试方案

在 `src/__tests__/tools.test.ts` 增加以下测试。

### Write

- 写入多层父目录均不存在的新文件，调用成功。
- 断言多层目录和文件内容都已创建。
- 对绝对路径执行同样的嵌套文件创建，保持现有绝对路径能力。
- 某一级父路径是普通文件时调用失败，且原文件未被覆盖。

### Edit

- `old_string=""` 创建多层父目录均不存在的新文件，调用成功。
- 普通 `old_string` 编辑同一路径时返回 `File does not exist.`。
- 普通 Edit 失败后，断言缺失的父目录没有被创建。
- `old_string=""` 写入现有空文件时保持成功。
- `old_string=""` 写入现有非空文件时保持失败且内容不变。
- 某一级父路径是普通文件时，创建模式失败且原文件未被覆盖。

### 回归验证

实施后先运行聚焦测试：

```text
bun test src/__tests__/tools.test.ts
```

最终运行完整验证：

```text
bun run check
```

## 验收标准

- 模型可以用一次 `Write` 调用创建任意深度的新文件，不需要先调用 `Bash mkdir`。
- 模型可以用一次 `Edit(old_string="")` 调用创建任意深度的新文件。
- 普通 Edit 对不存在文件的失败不遗留空目录。
- 已存在文件的 Read、快照和并发修改保护行为没有变化。
- 目录创建失败作为清晰、可纠正的普通工具错误返回。
- tool description、系统提示、实现和测试表达同一套语义。
- `bun run check` 通过。
