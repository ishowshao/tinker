# 产品加固阶段一：顶层 CLI 与 one-shot Prompt 输入技术方案

## 文档状态

- 状态：待实施。
- 日期：2026-07-22。
- 基线：Tinker `1.3.0`，commit `7822852dad23`。
- 上位方案：[`product-hardening-phase-one-design.md`](product-hardening-phase-one-design.md)。
- 范围：npm 包暴露的 `tinker` 顶层 CLI、one-shot Prompt 输入和只读 `doctor`。

本文是产品加固阶段一的 CLI 实施合同。公共配置字段、依赖安全、README 总体收口和发布
流程仍由上位方案负责；本文冻结命令语法、Prompt 输入、输出、退出码、所有权和测试边界。

## 1. 背景与当前问题

当前 `src/cli/index.ts` 直接读取 `process.argv`：

```ts
const [, , command, ...args] = process.argv;
```

它只特殊处理 `run` 和 `--profile`/`-p`，其余输入全部落入 `runTui()`。因此：

- 没有 `--help`、`--version` 或 `doctor`；
- 未知命令和未知 option 会误启动 TUI；
- 缺参数、多参数和子命令帮助没有统一合同；
- CLI parser、输出和 runner dispatch 耦合在入口文件中；
- `tinker run` 把任意多个 argv 用单个空格重新拼接，丢失参数边界，也无法诚实表示任意
  Prompt 文本。

最后一项不是靠换一个 argv parser 就能解决。shell 在 Tinker 启动前已经完成分词、去除
引号、变量替换、命令替换、glob、重定向等处理。Tinker 只能看到处理后的 argv，无法恢复
用户在命令行里原来输入的字节。

例如：

```bash
tinker run explain $HOME *.ts
```

传给 Tinker 的内容可能已经是：

```text
["run", "explain", "/Users/name", "a.ts", "b.ts"]
```

把这些值重新用空格连接，既不能恢复 `$HOME` 和 `*.ts`，也不能知道原来的空白与引用
边界。因此本阶段不再把 variadic argv 描述为“任意 Prompt”，而是提供三个明确、互斥的
输入通道。

## 2. 目标

- 使用成熟 CLI parser 声明命令、option、argument、help 和 version。
- 所有语法错误在 workspace、配置、session、MCP 或 model 初始化前 fast-fail。
- 短 Prompt 可以通过一个明确引用的位置参数提交。
- 任意多行文本、代码、shell 字符和敏感内容可以通过 stdin 或文件稳定提交。
- 三种 Prompt 来源统一成同一个未经改写的字符串，再进入现有 `runOneShot()`。
- `doctor` 在没有完整运行环境时也能给出只读、离线、脱敏的本地诊断。
- parser、Prompt 读取、doctor 和 runner dispatch 保持分层、可独立测试。
- npm tarball 中的 help、version、doctor 和 Prompt 输入在 macOS、Linux 都可验证。

## 3. 非目标

- 不改变 TUI 内的 Prompt Input、Prompt history、`@` 文件选择或 slash commands。
- 不为 one-shot 增加图片输入；`--file` 读取的是 Prompt UTF-8 文本，不是附件。
- 不新增 provider、session、context、Recall、MCP 或 tool 语义。
- 不支持从环境变量读取 Prompt；环境变量容易泄漏、受平台大小限制，也没有必要。
- 不支持 JSON envelope、Base64 Prompt 或自定义转义语言。
- 不尝试恢复 shell 已经展开或删除的原始字符。
- 不接受多个位置参数后猜测它们应如何拼接。
- 不实现 `doctor --fix`，不进行 provider connectivity check。
- 不为当前 variadic `run` 行为增加兼容分支。

## 4. 核心决定

1. 顶层 CLI 使用 `commander@^14.0.3`。
2. Commander 只拥有命令语法、help/version 和解析期错误，不拥有业务配置或 runtime。
3. Commander、runner 和 `main()` 都不直接终止进程；Node launcher 与 Bun executable guard
   只设置最终 `process.exitCode`，让 stdout/stderr 自然排空。子进程被 signal 终止时仍按原
   signal 转发。
4. `run` 的 Prompt 来源固定为单个位置参数、`--stdin`、`--file <path>` 三选一。
5. 顶层 `--profile`/`-p` 属于默认 TUI 命令；`run` 声明自己的同名 option，用于选择
   one-shot profile。
6. 不隐式探测 piped stdin；读取 stdin 必须显式写 `--stdin`。
7. 位置参数只有一个，不再支持 `<prompt...>` 或空格拼接。
8. Prompt 只验证 UTF-8、字节上限、NUL 和非空性，不 trim、不规范化换行、不追加换行。
9. help、version 和语法错误由依赖轻量的 bootstrap 处理；在命令确定前不得静态加载 TUI、
   runtime、tool 或 provider 模块。Prompt source 校验发生在任何 runtime 副作用之前。
10. CLI 结构错误和可预期的 Prompt 输入错误返回 `2`；运行或本地 I/O 故障返回 `1`。
11. one-shot 的 canonical user message 只保存最终 Prompt 文本，不增加 Prompt source 字段。
12. `tui`/`run` 路径每次进程最多执行一次 public config resolution；长期 TUI 可以从该冻结
    快照纯派生多个 session config，runner 不得重新读取 env/profile/tooling。显式持久化 default
    profile 是独立写操作，不得反向替换当前 runtime 快照。
13. `doctor` 同时验证 bundled ripgrep 和配置后实际生效的 ripgrep，并覆盖 CLI/session
    bootstrap 中可无副作用验证的只读本地输入。

## 5. Commander 选型

### 5.1 为什么引入

阶段一已经需要：

- 顶层 option；
- 子命令及子命令 help；
- required/optional argument；
- option 互斥与 excess argument 检查；
- 稳定的 help/version；
- async 主入口；
- 可注入 stdout/stderr；
- 可测试的 exit override。

继续手写条件分支会让这些规则分散到入口、测试和 README。Commander 已经提供相应的
解析和输出机制，引入它比扩展自制 parser 更容易形成稳定公共契约。具体 API 以
[Commander v14.0.3 官方文档](https://github.com/tj/commander.js/tree/v14.0.3)为准。

### 5.2 版本约束

阶段一使用：

```json
{
  "dependencies": {
    "commander": "^14.0.3"
  }
}
```

选择 v14 而非 v15 的原因：

- Tinker 当前 npm 安装合同是 Node.js `>=20`；
- Commander v14 的 Node engine 是 `>=20`；
- Commander v15 的 Node engine 是 `>=22.12.0`；
- 即使实际命令由包内 Bun 执行，引入 v15 仍会让 Node 20 的 npm 安装产生 engine 冲突
  或警告；阶段一不应为 CLI parser 无谓提高 Tinker 的安装门槛。

`^14.0.3` 不会跨入 v15。未来若 Tinker 主动提高 Node 安装要求，可以在独立依赖升级中
重新评估 Commander major，不在本阶段提前兼容。版本和 engine 结论在实施时还要通过
[`npm view commander`](https://www.npmjs.com/package/commander?activeTab=versions)复核并写入
lockfile，不从本文旧快照盲目安装。

### 5.3 使用约束

使用 `new Command()` 创建实例，不导入全局 singleton `program`，避免测试间共享状态。

必须配置：

- `.name("tinker")`；
- `.version(packageVersion, "-V, --version")`，传入不带程序名前缀的纯 package version；
- `.helpOption("-h, --help")`；
- `.helpCommand(true)`，支持 `tinker help` 与 `tinker help <command>`；
- 顶层 `.showHelpAfterError('Run "tinker --help" for usage.')`，并为 `run`、`doctor` 配置各自
  对应的 help hint；
- `.showSuggestionAfterError(false)`，避免 option/command 清单变化造成额外、漂移的诊断行；
- 顶层和每个子命令的 effective setting 必须是 `.allowExcessArguments(false)`；即使 Commander
  v14 当前默认拒绝 excess arguments，也要显式冻结并逐 command 测试本文的单位置参数合同；
- `.enablePositionalOptions()`，让顶层 option 只在子命令之前解析、子命令 option 在子命令
  之后解析；
- `.exitOverride()`，把 Commander 的终止转换为可分类错误；
- `.configureOutput()`，将输出写入注入的 stdout/stderr；
- `.parseAsync(args, { from: "user" })`。

顶层 command 必须声明 action，将空 argv 或只有顶层 `--profile` 的合法输入记录为 `tui`。
`run` 必须声明为 `run [prompt]`，不能声明 required `<prompt>`；argument/stdin/file 恰好三选一
由 action 内的纯校验逻辑完成后再记录为 `CliCommand`。否则 Commander 会在 `--stdin`、
`--file` 合法形式到达 Tinker 校验前先报缺少 `<prompt>`。

不启用：

- `.allowUnknownOption()`；
- `.allowExcessArguments(true)`；
- stand-alone executable subcommands；
- 隐式 option pass-through；
- Commander lifecycle hook 承载 runtime 初始化。

Commander action 只记录解析后的 `CliCommand`，不能在 action 内创建 session 或执行
runner。这样所有命令先完成完整解析，再由 composition root dispatch。

Tinker 自己的 argv/source invariant 失败抛出带 command scope 的 `CliUsageError`，由 `main()`
使用同一 output renderer 添加固定 hint；不得再调用 `program.error()` 造成 Commander 已写一次、
入口又写一次的重复 stderr。

每个逻辑 option 在一次调用中最多出现一次。`-p` 与 `--profile` 视为同一个 option；以下
全部是 usage error，而不是 last-one-wins：

```bash
tinker --profile a --profile b
tinker run -p a --profile b "hello"
tinker run --stdin --stdin
tinker run --file a --file b
```

Commander 对 required option value 默认是 greedy 的，后一个 token 即使以 `-` 开头也可能被
当作 value。Tinker 不继承这个容易混淆 Prompt source 的行为：当分离的下一个 token 以 `-`
开头时，无论它是已声明、未知、help/version option 还是 `--`，都按当前 option 缺少 value
返回 `2`。真正以 `-` 开头的文件路径必须使用 attached long form，例如
`--file=-prompt.md`；profile name 使用 `--profile=-name` 或 Commander 支持的 attached short
form `-p-name`。这一层检查属于纯 argv 语法校验，必须在配置或文件读取前完成。

Commander 的 option parsing 不能代替 Tinker 的 cross-command invariant。完成 parse 后、
读取配置或执行 command 前，必须显式验证：若顶层 `profile` 已设置且选中的 command 不是
`tui`，立即抛出 Tinker usage error 并映射为 exit `2`。`.enablePositionalOptions()` 不会拒绝
`tinker --profile kimi run "hello"`；它会把 `profile=kimi` 保留在顶层并正常选择 `run`，
因此不能依赖 Commander 自然失败。

成功 terminal parse 必须按 `CommanderError.code` 明确覆盖 `commander.help`、
`commander.helpDisplayed` 和 `commander.version`。其余 Commander parse error 都映射为 Tinker
usage error `2`。不得只处理 `commander.helpDisplayed`，因为 `tinker help run` 使用的是另一条
成功 help 路径。

## 6. 公共命令合同

### 6.1 完整语法

```text
tinker
tinker --profile <profile-name>
tinker -p <profile-name>

tinker run [--profile <profile-name>] <prompt>
tinker run [--profile <profile-name>] --stdin
tinker run [--profile <profile-name>] --file <path>

tinker doctor

tinker --help
tinker -h
tinker help
tinker help run
tinker help doctor

tinker --version
tinker -V
```

子命令同时支持自己的帮助：

```text
tinker run --help
tinker doctor --help
```

### 6.2 Profile option 所有权

`tinker` 启动 TUI。子命令之前的顶层 `--profile`/`-p` 只对 TUI 默认命令有效：

```bash
tinker --profile kimi
tinker -p kimi
```

profile name 必须是一个 `trim()` 后非空的 argv 值，但传给 production profile resolver 的仍是
原始值，不做名称规范化。重复 profile option 和额外位置参数都是 usage error。以下输入全部
返回 `2`：

```bash
tinker --profile
tinker --profile a -p b
tinker --profile kimi extra
tinker unknown
tinker --unknown
```

`run` 声明自己的 `--profile`/`-p`，option 必须写在 `run` 之后：

```bash
tinker run --profile kimi "hello"
tinker run -p kimi --stdin
tinker run --file prompt.md -p kimi
```

该值进入与 TUI 相同的 production profile parser。未提供时，one-shot 使用公共配置中的
default profile 或 env mode；在 env mode 下显式选择 profile 必须在 config boundary 明确
失败，不能静默忽略。

顶层 profile 仍不允许与 `run` 或 `doctor` 组合：

```bash
tinker --profile kimi run "hello"
tinker --profile kimi doctor
```

两者都返回 `2`。这不是因为 Commander 无法解析，而是为了让每个 option 的 owner 由位置
确定：子命令前属于顶层 TUI，`run` 后属于 one-shot；`doctor` 不接受 profile option。

唯一例外是成功的 terminal help/version parse：

```bash
tinker --profile kimi --help
tinker --profile kimi help run
tinker run --profile kimi --help
```

这些命令只显示请求的 help 并返回 `0`，不执行 post-parse profile invariant，也不读取配置。
help/version 一旦在其合法 command scope 内被识别，就作为终止性查询优先；它们不用于验证
同一次调用中的其他业务参数。`tinker run --version` 仍是未知 subcommand option，因为 version
只属于顶层 command。

### 6.3 Help 与 version

help 和 version 必须在读取以下内容之前完成：

- `TINKER_*` model 配置；
- workspace realpath；
- `.tinker.json`、`.mcp.json`、AGENTS.md、skills；
- session catalog 或 SQLite；
- provider client。

`--version` 固定输出：

```text
<package-version>
```

例如 package version 为 `1.3.0` 时，stdout 精确为 `1.3.0\n`。version 来自实际安装根的
`package.json`，不得在源文件复制版本常量，也不得把 `tinker ` 前缀写入 Commander 的
version value。这样 `program.version()` 仍返回干净 package version，shell 也可以直接消费
`$(tinker --version)`。

help 中必须列出三种 Prompt 来源，并明确复杂或敏感 Prompt 优先使用 `--stdin` 或
`--file`。help 不复制完整 shell quoting 教程，README 负责提供示例。

usage error 的 help hint 固定为当前 command：顶层使用
`Run "tinker --help" for usage.`，`run` 使用 `Run "tinker run --help" for usage.`，`doctor`
使用 `Run "tinker doctor --help" for usage.`。Commander parse error 与 Tinker 自己产生的
post-parse invariant/source-conflict error 必须经过同一个 renderer，不能出现两套格式。

## 7. Prompt 来源合同

### 7.1 类型

CLI parser 产出封闭的来源类型：

```ts
export type PromptSource =
  | { readonly kind: "argument"; readonly value: string }
  | { readonly kind: "stdin" }
  | { readonly kind: "file"; readonly filePath: string };
```

`resolvePromptSource()` 统一返回：

```ts
export type ResolvedPrompt = {
  readonly text: string;
  readonly byteLength: number;
};
```

`runOneShot()` 只接收 resolved text，不读取 argv、stdin 或文件。

### 7.2 三选一

调用 `run` 时必须恰好选择一个来源：

```bash
tinker run "Explain this repository"
tinker run --stdin
tinker run --file prompts/review.md
```

以下输入是 usage error，返回 `2`：

```bash
tinker run
tinker run "hello" "world"
tinker run "hello" --stdin
tinker run "hello" --file prompt.md
tinker run --stdin --file prompt.md
tinker run --stdin extra
tinker run --stdin --stdin
tinker run --file a --file b
```

不要让 Commander 自动接受多个 positionals，不要在 parser 后拼接，也不要让重复的同类
source option 退化成幂等或 last-one-wins。source occurrence 和 source kind 都必须恰好为一。

### 7.3 单个位置参数

位置参数适合较短、方便 shell quoting 的 Prompt：

```bash
tinker run "explain the project structure"
tinker run 'explain `$HOME` and *.ts literally'
tinker run $'first line\nsecond line'
tinker run -- "-leading text"
```

`--` 结束 option parsing，因此以 `-` 开头的 Prompt 必须位于 `--` 后。`--` 本身不进入
Prompt。

位置参数到达 Bun 时已经是 JavaScript string。Tinker 不尝试推断用户使用了哪种 shell，
也不反向处理引号、反斜杠、变量或 glob。

### 7.4 stdin

复杂、多行或敏感 Prompt 的首选入口是显式 stdin：

```bash
tinker run --stdin <<'PROMPT'
Review this shell code without expanding it:

for file in "$HOME"/*.ts; do
  echo "$(basename "$file")"
done
PROMPT
```

文档示例使用带引号的 heredoc delimiter，避免 shell 展开正文。

管道示例：

```bash
git diff | tinker run --stdin
printf '%s\n' 'Explain `$HOME`, *.ts, and "quotes".' | tinker run --stdin
```

读取规则：

- 必须持续读取到 EOF；
- 按字节累计并在超过上限时立即停止读取、返回明确错误；
- 不根据 `stdin.isTTY` 自动切换模式；
- `--stdin` 下即使 stdin 是 TTY 也按显式请求读取，用户可用 EOF 结束；
- stdin read fault 是运行 I/O failure，返回 `1`。

不支持省略 `--stdin` 的隐式形式：

```bash
printf 'hello' | tinker run
```

该命令仍因缺少 Prompt source 返回 `2`，不能根据父进程偶然提供的 pipe 改变语义。

### 7.5 文件

文件入口：

```bash
tinker run --file prompts/review.md
```

规则：

- file option value 必须至少包含一个字符；`--file=` 在任何 I/O 前返回 usage error `2`；
- 相对路径相对进程 cwd，不相对 `TINKER_WORKSPACE`；
- 绝对路径允许位于 workspace 外，因为用户显式选择了本地 Prompt source；
- 使用只读加 non-blocking flag 打开，避免 FIFO 在类型检查前等待 writer；
- 打开后通过 `fileHandle.stat()` 确认是 regular file；目录、FIFO、socket 和 device 直接
  拒绝；
- 通过同一个已打开 file handle 完成最终类型、上限检查和读取；
- 即使初始 `stat.size` 在上限内，实际读取仍最多接收 `MAX + 1` bytes，文件并发增长不能
  绕过上限；
- symlink 可以跟随到 regular file，最终仍只读取显式路径指向的内容；
- 文件缺失、权限拒绝、非 regular file 或读取失败返回清晰错误；
- `--file` 不根据后缀选择格式，也不解析 Markdown frontmatter。

文件内容不会被当作 Tinker `Read` tool observation；它只成为当前 one-shot user Prompt。

文件错误按语义而不是仅按“发生在 open 前还是后”分类：

| 类别 | 例子 | exit code |
| --- | --- | --- |
| 用户选择的 source 不可用 | `ENOENT`、`ENOTDIR`、`EACCES`、`EPERM`、`ELOOP`、`ENAMETOOLONG`、目录或非 regular file | `2` |
| Prompt 内容不合法 | 超限、invalid UTF-8、NUL、空或纯空白 | `2` |
| 进程或系统资源故障 | `EMFILE`、`ENFILE`、`ENOMEM`、`EIO`、无法关闭 handle | `1` |

未列出的 errno 根据它是否可通过用户更正 source 来分类，并为每个新增映射补测试；不得因为
macOS 与 Linux 在 open/stat 阶段返回不同 errno 而改变同一语义的 exit code。

### 7.6 文本校验与保持

统一常量：

```ts
export const MAX_ONESHOT_PROMPT_BYTES = 1 * 1024 * 1024;
```

三个来源都执行相同校验：

1. UTF-8 byte length 不得超过 1 MiB；argument 使用 `Buffer.byteLength()`，stdin/file 在
   decode 前按原始字节限制。
2. stdin/file 使用 `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`；无效 UTF-8
   直接拒绝，不替换成 U+FFFD，BOM 解码为正文 U+FEFF。
3. 文本不得包含 U+0000 NUL。
4. `text.trim().length` 必须大于零，但 trim 只用于判空。
5. 返回和提交的 `text` 必须保持原值。

保持原值意味着：

- 不 trim 首尾空白；
- 不把多个空格合并；
- 不把 CRLF 改成 LF；
- 不删除或追加末尾换行；
- 不解释反斜杠或转义序列；
- 不移除 Markdown fence；
- UTF-8 BOM 若解码为 U+FEFF，也作为正文保留。

1 MiB 是 CLI admission 上限，不代替 model context preflight。较小 context profile 仍可能在
session admission 时因 token budget 失败；CLI 不根据粗略字符数猜测 provider budget。

### 7.7 敏感信息

位置参数可能出现在 shell history、process listing 或调用者日志中。README 必须明确：

- 普通短 Prompt 可以使用引用的位置参数；
- 包含 secret、私有补丁或长代码时优先使用 `--stdin`；
- `--file` 由用户负责设置文件权限和生命周期。

CLI 错误不得回显完整 Prompt。错误只报告 source kind、实际字节数、上限或经过安全渲染的
文件路径；NUL、无效 UTF-8 和空内容错误不附带正文预览。文件路径使用 JSON 风格转义控制
字符，并按 UTF-8 字节截断到第 9 节固定的 `512` bytes，避免换行、ANSI 或超长 argv 注入
诊断输出。截断只影响错误展示，不改变实际打开的路径。

## 8. 解析与执行架构

### 8.1 数据流

```text
bin/tinker.js (dependency-light Node launcher)
  -> bundled Bun src/cli/index.ts (dependency-light executable guard)
  -> load package metadata
  -> parseCommandLine(argv)
       -> help/version/usage terminal result
       -> CliCommand
  -> validate cross-command invariants
  -> command=doctor: dynamically load runDoctor and its read-only probes
  -> command=tui/run: dynamically load config boundary only
       -> resolve one immutable public-config snapshot
       -> derive selected RunnerConfig without further config I/O
  -> command=run: resolve PromptSource
  -> dynamically load selected TUI/one-shot runner
  -> dispatch runTui(config snapshot) / runOneShot(RunnerConfig, Prompt)
```

关键顺序：

- package metadata 只读取安装包自身，不读取 workspace；
- 完整 argv parse 必须先于 Prompt source、配置和 runner；
- `bin/tinker.js` 只负责解析 bundled Bun、同步转发 stdio/signal 和传播 exit code，不加载
  Commander 或应用模块；
- `index.ts`、`main.ts`、`command-line.ts` 和 `package-metadata.ts` 的静态 import graph 不得触达
  TUI、agent runtime、tool registry、MCP manager、provider client 或 `@vscode/ripgrep`；
- help/version/usage terminal result 返回后不得再执行 config、doctor 或 runner dynamic import；
- `main()` 的默认 production dependency 也必须是选中 command 后才求值的 lazy loader，不能
  因“可注入”而在模块顶层静态 import 所有 runner；
- `run` 先完成语法解析，再加载 model 配置，最后读取 Prompt；三者都在 session 创建前完成；
- 缺少 model 配置时不得先等待 stdin EOF 或读取 Prompt 文件；
- TUI/one-shot runner module 只在对应 config（以及 one-shot Prompt）成功后 dynamic import；
  config 或 Prompt failure 不得仅为返回错误而加载 Ink、agent runtime、tool registry 或 provider；
- 当前 `config.ts` 中的 `createRunnerModelClient()`、provider client 和 WebFetch refiner factory 必须
  移到 selected-runner dependency 层；config boundary 只解析数据并纯派生，不得因读取配置而
  加载 provider/tool implementation；
- public config 在 `tui`/`run` 的 CLI composition root 最多读取一次，runner 不再重复读取
  env/profile/tooling；
- doctor 使用 production config parser，但不调用 runner；
- TUI 及其 Ink/React 依赖只在命令明确为 `tui` 后加载和初始化。

该顺序依赖上位方案 P1.1 先完成配置所有权上移。当前
`src/cli/run-runner.ts` 的 `runOneShot()` 会在内部调用 `loadModelProfiles()` 和
`readRunnerConfig()`；P1.2 不得在 `main()` 增加一次相同 preflight 后仍让 runner 再解析。
P1.1 必须先建立下一节的“读取一次、选择多次”边界，P1.2 才能在 config 通过后安全读取
stdin/file。

### 8.2 配置快照与 session config 派生

P1.1 必须把当前同时承担 I/O、profile 选择和 session identity 生成的 `readRunnerConfig()` 拆成
两个边界：

```ts
export async function resolvePublicConfig(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}): Promise<ResolvedPublicConfig>;

export function deriveRunnerConfig(
  snapshot: ResolvedPublicConfig,
  selection: {
    readonly sessionId: SessionId;
    readonly profileName?: string;
  },
): RunnerConfig;
```

实际字段可按上位方案的公共声明拆分，但语义固定：

- `resolvePublicConfig()` 是唯一读取 env、`TINKER_MODELS`、workspace/tooling 配置并执行公共
  primitive/cross-field 校验的入口；返回值是当前进程使用的不可变快照；
- 它内部的 model/profile、workspace 与 tooling production sub-resolver 可以为 doctor 导出，
  但 `tui`/`run` 只能调用完整 facade；doctor 对每个 sub-resolver 最多调用一次以保留独立诊断；
- 快照包含 env mode 的规范化配置，或完整、已验证的 profile catalog，以及所有 tooling
  config；不得包含随机生成的 `sessionId`；
- `deriveRunnerConfig()` 是无 I/O 的纯函数；它选择 default/显式 profile、拒绝 env mode 下的
  profile 选择、派生 context budget，并绑定调用者提供的 session identity；
- one-shot 只派生一次；TUI 可在 initial、resume、`/model`、`/clear`、`/fork` 等生命周期中从
  同一快照多次派生，但不得重新读取 `process.env` 或 profile 文件；
- 新 session 的 UUID 只在确实准备创建该 session 时生成。doctor 只验证快照，不生成 session
  identity；
- TUI 显式持久化新的 default profile 是现有产品写操作，不算第二次 runtime resolution；写入
  路径可为原子更新重新读取并用 production parser 验证文件，但结果不得替换当前进程已冻结的
  profile 定义快照，也不得使外部修改悄悄进入当前 session 生命周期。

这一区分避免把“一次 config resolution”误解成“整个 TUI 永远只有一个 RunnerConfig”。后者
会破坏当前多 session、resume 和 profile switching 语义。

### 8.3 `CliCommand`

建议类型：

```ts
export type CliCommand =
  | { readonly type: "tui"; readonly profileName?: string }
  | {
      readonly type: "run";
      readonly profileName?: string;
      readonly promptSource: PromptSource;
    }
  | { readonly type: "doctor" };
```

help/version 由 Commander 作为成功 terminal parse 处理，不伪装成 runtime command。

### 8.4 可导入的 `main()` 与可执行入口

`src/cli/main.ts` 导出可测试的 `main()`；`src/cli/index.ts` 只在 executable guard 内 dynamic
import 它，使单纯 import `index.ts` 连 Commander 都不会加载：

```ts
async function runExecutable(): Promise<number> {
  let mainModule: typeof import("./main");
  try {
    mainModule = await import("./main");
  } catch {
    process.stderr.write("Tinker failed to start. Reinstall tinker-agent.\n");
    return 1;
  }

  try {
    return await mainModule.main({
      args: process.argv.slice(2),
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      cwd: process.cwd(),
      env: process.env,
    });
  } catch {
    process.stderr.write("Tinker failed unexpectedly.\n");
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runExecutable();
}
```

dynamic import failure 使用固定 reinstall 提示；第二层 catch 只是 `main()` 违反 total-boundary
合同后的最后兜底，不输出 stack。正常命令错误必须由 `main()` 分类。`main()` 返回 exit code，
不调用 `process.exit()`；`runTui()`、`runOneShot()`、doctor 和 Commander override 也不得调用
它。TUI `/quit` 必须完成 Ink、session、MCP 和 background task 清理后正常返回，让 executable
guard 统一设置 `process.exitCode`。强制退出会跳过 stdout/stderr 的自然排空，因此不能作为
“确保 CLI 结束”的手段。

`bin/tinker.js` 同样改为可返回 code 的 launcher 函数；缺少 bundled Bun 或 spawn failure 时
输出不含底层 message 的固定 reinstall 提示并返回 `1`，正常 child completion 赋给
`process.exitCode`。只有 child 被 signal 终止时使用 `process.kill(process.pid, signal)` 保持 shell
可观察到的 signal 语义；不得用 `process.exit()` 模拟 signal 或普通 exit code。

`main()` 的生产依赖使用默认实现，测试则可注入 package metadata、config resolution、doctor
和 runner dispatch probe，以证明 terminal parse 没有加载或调用后续边界。测试直接 import
`main.ts` 或 `index.ts` 都不能启动命令、写输出或改变 `process.exitCode`，也不需要 monkey-patch
`process.exit`、`process.env` 或 cwd。

`main()` 开始时复制 args 与 env，并固定 cwd；之后 parser、config、doctor 和 runner 只接收该
调用快照，不在 await 间隙重新观察全局 `process.argv`、`process.env` 或 cwd。

`main()` 是公共错误边界：Commander 成功终止、usage error、配置/Prompt 错误、runner 返回值
和未预期异常都必须被映射为一个最终 exit code；未预期异常也只经过第 9 节 renderer 输出一条
有界摘要，不把未处理 rejection、stack 或 error object 交给 Bun 默认打印。runner 已经写过的
产品输出不得由 `main()` 重复输出。

安装根 package metadata 缺失、不可读或无法解析使用独立的 typed bootstrap error，`main()`
将其映射为固定 reinstall 提示和 `1`，不泄漏底层路径或 parser message。name/bin/dependency 的
语义不匹配仍由 doctor 的 package check 报告，不阻止一个结构完整的 CLI 显示 help/version。

Commander 的 `CommanderError` 必须按 `code` 分类，而不是通过英文 message 做字符串匹配。
help/version 是成功终止；未知 option、缺 argument、excess argument 和冲突 source 是
usage error。

## 9. 输出与退出码

| 情况 | stdout | stderr | exit code |
| --- | --- | --- | --- |
| help | Commander 渲染的帮助 | 空 | `0` |
| version | `<package-version>` 单行 | 空 | `0` |
| launcher/bootstrap/install metadata 无法使用 | 空 | 固定、无底层细节的 reinstall 提示 | `1` |
| usage error | 空 | 单个错误和当前 command 的固定 usage hint | `2` |
| Prompt source 不可用、非 regular、超限、空、NUL 或编码无效 | 空 | 有界、无正文的输入错误 | `2` |
| Prompt stdin/file 的系统资源或意外 I/O fault | 空 | 有界本地错误 | `1` |
| public config 缺失/非法、未知 profile 或 workspace 非法 | 空 | 脱敏配置错误 | `1` |
| doctor 全部通过 | 检查项、限制说明和最终 `RESULT PASS` | 空 | `0` |
| doctor 检查失败 | 已完成检查项、限制说明和最终 `RESULT FAIL` | 脱敏失败摘要 | `1` |
| TUI/one-shot runtime failure | 保持 runner 产品输出 | 运行错误 | `1` |

Commander 默认的 usage error exit code 可能不是 Tinker 合同值；入口必须统一映射为 `2`。
不要让 library default 决定产品 exit code。

未知 profile 和缺少 model 配置不是 argv 结构错误；它们已通过语法解析，属于 public config
failure 并返回 `1`。相反，空 profile argv value、重复 option、source 冲突和 excess argument
仍返回 `2`。

统一常量 `MAX_CLI_DIAGNOSTIC_DETAIL_BYTES = 512`。错误 renderer 必须清除 ANSI、转义换行和
其他控制字符，并让每条 error/doctor summary 的动态 detail 连同确定性的 truncation marker
不超过该 UTF-8 字节上限；截断不得切开 code point。不得把底层 error object、stack、完整 env
value 或 Prompt 正文直接插入公共 stderr。

输出 writer 由依赖注入提供。测试使用内存 writer；生产传入 process stdout/stderr。若 writer
暴露 backpressure 或异步 flush，调用方必须在返回 exit code 前等待它完成；Commander 的同步
output callback 可以先写入命令级 buffer，再由 `main()` 统一 flush。无论采用哪种 adapter，
`main()` 都不通过 `process.exit()` 抢先结束；进程级测试必须证明 pipe 中的完整输出和最终
exit code 同时可观察。

## 10. `tinker doctor`

### 10.1 目的与边界

doctor 回答“当前安装、公共配置，以及 CLI/session bootstrap 会消费的只读本地合同是否能
通过 production parser”，不模拟完整 session 初始化，也不回答“远端 provider 是否可用”。
它必须只读、离线、确定：

- 不调用 model 或 token estimator；
- 不启动 MCP server；
- 不创建 session、asset、history 或 workspace 文件；
- 不修复配置和权限；
- 不输出 API key、profile secret 或 `.mcp.json` 的 env 内容。

因此 PASS 仍不承诺 workspace 可写、session store 可创建、MCP server 可启动或 provider 可
连接；这些边界需要实际 runtime 才能验证。相反，AGENTS/CLAUDE、Agent Skills、`.tinker.json`
等在调用 `createRuntimeSession()` 前就会被 production runner 读取的内容，以及 `.mcp.json`
这类可在不启动 MCP 的前提下独立验证的 session-bootstrap 配置，都必须纳入 doctor。doctor
不能在 production parser 已能确定失败时给出假阳性。

Node launcher、Commander 和可读取的安装根 package metadata 是 doctor 自身能够启动的最小
bootstrap 前提。若 Bun package/executable 或 package metadata 已损坏到入口无法启动，
`bin/tinker.js`/bootstrap 直接输出有界 reinstall error 并返回 `1`；doctor 不声称能在自身无法
执行时生成表格。package check 负责发现入口已经能读取、但 name/version/bin/dependency identity
不符合发布合同的情况。

### 10.2 固定检查顺序

1. **package**：安装根 package name 是 `tinker-agent`，version 非空，bin 只暴露
   `tinker`。
2. **bun**：当前入口运行在 Bun 下，且 runtime version 按 SemVer precedence 大于等于实际
   安装包 `dependencies.bun` 声明的版本。该依赖必须是可解析的精确稳定版本，作为最低兼容
   基线，不能在 doctor 源码中复制版本常量。发布入口会启动包内 Bun，通常精确命中；源码
   开发使用兼容的较新 Bun 也必须 `PASS`，低于基线、pre-release 或无法识别版本才 `FAIL`。
3. **bundled ripgrep**：忽略 `TINKER_RIPGREP_PATH`，从安装根解析包内
   `@vscode/ripgrep` executable，运行 `--version` 且 exit `0`。该项证明发布包装完整。
4. **workspace**：按 production 规则解析 workspace，realpath 存在且是可读目录；不写
   `.tinker`。
5. **public config**：调用 `resolvePublicConfig()` 所使用的 production model/profile 与 tooling
   resolver，分别验证 profile/env mode、context budget 和所有 tooling config，再汇总成一个
   check；一个子域失败不阻止其他独立子域继续。secret 只报告 configured/missing，不生成
   session identity。
6. **effective ripgrep**：若未设置 `TINKER_RIPGREP_PATH`，复用 bundled probe 的结果且不重复
   spawn；若设置 override，则对 production tooling resolver 为 public snapshot 产出的 effective
   executable 独立运行 `--version`。bundled 与 effective 任一失败都使 doctor 最终失败。
7. **project instructions**：复用 `loadProjectInstructions()` 验证优先级、regular file、
   workspace 边界、大小、NUL、UTF-8 和非空合同，但不构造 session。
8. **agent skills**：复用 `loadSkillCatalog()` 验证 project 与 user 两个固定 scope 的完整发现
   快照，包括 symlink/trust boundary、frontmatter、数量与字节上限；不激活 skill，也不执行
   resource 或 script。
9. **project config**：存在时用 production parser 验证 `.mcp.json` 与 `.tinker.json`，但
   不连接或执行；两者独立运行，一个失败不能阻止另一个完成，最终汇总为一个 bounded check。
10. **result**：无 `FAIL` 才返回 `0`。

两个 ripgrep probe 共用固定执行合同：不经过 shell，只传 `--version`，timeout 为 `5_000 ms`，
stdout/stderr 各最多读取 `64 KiB`，超时、超限、spawn error 或非零 exit 都是 `FAIL`。child env
只从调用快照 allowlist `PATH`、`LANG`、`LC_ALL`、`TMPDIR` 并强制 `NO_COLOR=1`，不得把 model/
tool secret 传给被探测 executable；summary 只使用安全渲染后的首个非空 version 行。这里的
“离线”指 Tinker 不创建网络 client 或主动发请求；显式 `TINKER_RIPGREP_PATH` 指向的是用户选择
执行的本地程序，其自身行为属于与正常 Grep 执行相同的信任边界。

各项输出 `PASS`、`FAIL` 或因前置依赖失败产生的 `SKIP`。独立检查尽量继续，一次显示多个
本地问题。依赖规则固定为：

- package 失败时，bun baseline 和 bundled ripgrep 为 `SKIP`；workspace/public config 等独立
  检查继续；
- workspace 失败时，project instructions、agent skills 和 project config 为 `SKIP`；
- `TINKER_RIPGREP_PATH` 所属的 production tooling resolver 失败时，effective ripgrep 为
  `SKIP`；model/profile 子域失败不阻止 effective ripgrep，doctor 也不得另写一套 env parser；
- bundled ripgrep 失败且没有 override 时，effective ripgrep 为 `SKIP`；有 override 时仍独立
  检查 effective executable；
- 缺少可选的 AGENTS/CLAUDE、skills root、`.mcp.json` 或 `.tinker.json` 是对应检查的正常
  `PASS`，不是 `SKIP`。

每个检查的 stdout 行固定为 `<STATUS> <check-id>: <bounded-summary>`；check id 固定使用
`package`、`bun`、`bundled-ripgrep`、`workspace`、`public-config`、`effective-ripgrep`、
`project-instructions`、`agent-skills`、`project-config`。九个检查行之后，无论 PASS/FAIL 都
依次输出三条限制说明，最后一行才是 `RESULT PASS` 或 `RESULT FAIL`：

```text
Provider connectivity was not checked.
MCP server startup was not checked.
Session storage writability was not checked.
RESULT <PASS|FAIL>
```

失败时 stderr 只增加一行 `Doctor found <N> failed checks.`，其中 `N` 只统计 `FAIL`，不统计
`SKIP`；不得重复底层错误。所有 summary 使用第 9 节的有界、去控制字符 renderer。

### 10.3 实现所有权

`src/cli/doctor.ts` 依赖 production config、project-instruction、skill 和 project-config
loader，以及可注入 package/runtime/subprocess probes。它不得静态 import runner 或 tool
registry；bundled ripgrep 通过 package metadata 安全解析，effective ripgrep 来自构成 public
snapshot 的 production tooling 子结果，因此不依赖 model/profile 子结果成功。不得从
`runTui()` 或 `runOneShot()` 中途截断来模拟 doctor，因为 runner 会跨入 session、model、skills
和 MCP 等有副作用的边界。

`runDoctor()` 接收 `main()` 冻结的 env/cwd/package metadata 与 probe dependencies；检查过程中
不得再次直接读取或修改 `process.env`、cwd 或全局 writer。这样多个 sub-resolver 观察的是同一
输入快照，测试也不需要修改全局进程状态。

## 11. 模块拆分

| 文件 | 责任 |
| --- | --- |
| `bin/tinker.js` | dependency-light Node launcher；解析 bundled Bun、继承 stdio、转发 signal、设置 child exit code |
| `src/cli/public-cli-contract.ts` | 无副作用的公共 command/option/usage 元数据；由 Commander tree 与 README renderer 共同消费 |
| `src/cli/command-line.ts` | 从公共声明建立依赖轻量的 Commander tree、option occurrence/value 消歧、解析成 `CliCommand` |
| `src/cli/output.ts` | exit 分类、同步 capture/async flush adapter、控制字符清理与有界公共错误 renderer |
| `src/cli/prompt-source.ts` | 三种来源、bounded read、UTF-8/NUL/空内容校验 |
| `src/cli/package-metadata.ts` | 从实际安装包读取 name/version/bin identity 与 Bun 最低兼容基线 |
| `src/cli/doctor.ts` | production read-only loader probes、固定状态模型和脱敏报告 |
| `src/cli/main.ts` | 可导入的 `main()`、dynamic command loading、一次 public config resolution 与 dispatch |
| `src/cli/index.ts` | `import.meta.main` executable guard、lazy `main()` import 与 `process.exitCode`；不拥有 command/runtime 逻辑 |
| `src/cli/config.ts` | 从 P1.1 公共声明解析 `ResolvedPublicConfig` 并纯派生 `RunnerConfig`；不 import provider/tool implementation |
| `src/cli/runner-dependencies.ts` | selected runner 才加载的 model client、refiner 与 runtime dependency factory（名称可按实现微调） |
| `src/cli/tui-runner.tsx` | 接收配置快照；可纯派生多 session config；不读取 env/profile，不调用 `process.exit()` |
| `src/cli/run-runner.ts` | 接收 resolved `RunnerConfig` 和 Prompt string；不理解 Prompt source，也不再加载 env/profile |
| `src/__tests__/command-line.test.ts` | 命令语法、help/version、Commander error mapping |
| `src/__tests__/cli-launcher.test.ts` | Node launcher 的 Bun lookup、stdio、普通 code 与 signal 传播 |
| `src/__tests__/cli-main.test.ts` | import guard、lazy loading、config/Prompt/dispatch 顺序、输出排空与 exit code |
| `src/__tests__/prompt-source.test.ts` | argument/stdin/file 的边界、保持与失败 |
| `src/__tests__/doctor.test.ts` | 检查顺序、依赖图、production loader 覆盖、无副作用和脱敏 |
| `scripts/verify-release-package.ts` | 从真实 tarball 验证公共 CLI |

`src/agent`、`src/context`、`src/session` 和 TUI 交互语义不应因本文改变；TUI runner 移除深层
process exit、改用配置快照属于 composition/lifecycle 边界调整，不得改变 `/quit`、resume、
`/model`、`/clear` 或 `/fork` 的用户行为。

## 12. 测试方案

### 12.1 Commander parser

- 空 argv -> TUI；
- 根 command action 对空 argv 和单个顶层 profile 精确产出 TUI，不退化成 Commander 默认 help；
- `--profile`/`-p` 合法、空值、缺值、重复逻辑 option 和 excess value；
- `run --profile`/`run -p` 对 argument/stdin/file 均可用，并把 profile 记录在 run command；
- `run` 未指定 profile 时保持 default profile/env mode，未知 profile 和 env mode 下显式
  profile 在 config boundary fast-fail；
- 精确覆盖 `--profile kimi run "hello"`、`--profile kimi doctor`：Commander parse 可成功，
  但 Tinker post-parse invariant 必须在配置和 runner 前返回 `2`；
- `run [prompt]` 的三种合法来源，证明 `--stdin`/`--file` 不被 required argument 提前拒绝；
- 缺 source、source 冲突、重复同类 source、excess positional；
- 重复 `-p`/`--profile` 和 `--file` 是错误而不是 last-one-wins，重复 `--stdin` 不是幂等；
- `--file --stdin`、`--file --unknown`、`--profile --help` 等分离 option-looking value 返回当前
  option 的缺值错误；
- `--file=-prompt.md`、`--profile=-name`、`-p-name` 的 attached leading-dash value 行为确定；
- `--` 后以 `-` 开头的单 Prompt，argv occurrence/value 预检不得把其重新解释为 option；
- 顶层和子命令未知 option；
- 顶层、run、doctor help，以及 `commander.help`/`commander.helpDisplayed` 两条成功路径；
- `--profile kimi --help`、`--profile kimi help run`、`run --profile kimi --help` 都不加载配置；
- `--version`/`-V`；
- 顶层、run、doctor usage error 使用各自固定 help hint；
- 拼写接近的未知 command/option 不输出 Commander suggestion；
- help/version/usage error 不加载 workspace、config 或 selected-command runtime module；
- 每次测试创建新的 Commander 实例，无状态泄漏。

### 12.2 配置快照与派生

- env mode、profile mode 和全部 tooling config 每次 `main()` 最多执行一次 runtime
  resolution；
- `main()` 启动后的原始 args/env/cwd 变化不影响本次调用快照；
- `ResolvedPublicConfig` 不含 session ID，doctor 不分配 runtime identity；
- one-shot 从选定 profile 派生一次 config，且 config failure 发生在 stdin/file 读取前；
- TUI initial、resume、`/model`、`/clear` 和 `/fork` 从同一快照派生正确的新/existing session
  identity 与 profile，不重新读取 env/profile 文件；
- env mode 下显式 profile 在纯 derive boundary 失败；
- 进程运行期间外部修改 profile 文件不会悄悄改变已解析的 profile 定义；
- 显式持久化 default profile 可在独立写路径重新读取并验证目标文件，但不触发第二次 runtime
  resolution，也不替换当前快照。

### 12.3 Prompt source

- argument 保留空格、tab、换行、引号、反斜杠、emoji 和前后空白；
- stdin chunk 边界跨越多字节 UTF-8 code point；
- file 通过同一 handle 读取；
- CRLF、末尾换行和 BOM 保持；
- 1 MiB 精确边界成功，超过一个字节失败；
- invalid UTF-8、NUL、空字符串和纯空白失败；
- file missing、permission、symlink loop、过长路径、directory、FIFO 以 `2` 失败；
- 空 file option value 在 I/O 前以 `2` 失败；
- `EMFILE`/`ENFILE`、open/read `EIO` 和 close failure 以 `1` 失败；
- 同一语义在 macOS/Linux 返回不同 open/stat errno 时仍映射为同一 exit code；
- stdin 超限后停止读取并解除监听，不保留悬挂 reader；
- stdin/file 错误不包含正文或 secret，路径控制字符被转义且 detail 不超过 512 bytes；
- 多 source 在任何读取前失败。

### 12.4 Doctor

- 完整 env mode、text profile、image profile；
- 缺配置、错误 budget、未知 profile 字段；
- workspace 不存在；
- 无/合法/损坏 `.mcp.json` 与 `.tinker.json`；
- 无/合法/损坏/越界/超限的 project instructions 与 project/user Agent Skills；instructions 精确
  覆盖 AGENTS 优先、AGENTS 无效不回退、AGENTS 存在时不读取 CLAUDE 的 production 语义；
- Bun runtime 等于或高于 `dependencies.bun` 时成功，低于基线、pre-release、非法版本或非
  Bun runtime 时失败；
- bundled ripgrep 与 effective ripgrep 分别成功/失败；override 无效时不得因 bundled 可用而
  PASS，override 有效时也不能掩盖发布包缺失 bundled binary；
- ripgrep probe 的 timeout、output cap、无 shell、child env allowlist、控制字符输出和非零 exit；
- package、workspace、tooling config 和 bundled ripgrep 失败时精确断言 `SKIP` 依赖图，独立
  检查继续；
- check id、顺序、`RESULT PASS/FAIL`、三条 not-checked footer 和 stderr failure count 精确；
- 输出不含注入的 API key 和 MCP secret；
- 不创建 `.tinker`，不分配 session ID，不发网络请求，不启动 MCP，不激活或执行 skill。

### 12.5 入口进程与发布包

- import `main.ts` 或 `index.ts` 不执行 CLI、不写输出、不修改 `process.exitCode`；
- import `index.ts` 不加载 `main.ts`/Commander；作为 executable 运行时，module/bootstrap import
  failure 只输出固定 reinstall 提示并返回 `1`；
- package metadata 缺失、不可读、malformed 与语义 identity mismatch 分别覆盖 bootstrap
  failure 和 doctor package failure，不泄漏底层 parser/path；
- help/version/usage 进程不加载 TUI/runtime/tool/provider modules；doctor 只加载自己的只读
  probe graph；
- config failure 不加载 TUI/one-shot runner，Prompt failure 不加载 one-shot runner；
- TUI `/quit` 和 one-shot completion 都由 runner 正常返回，没有深层 `process.exit()`；
- Node launcher 对缺 bundled Bun、spawn failure、普通 child code 和 signal termination 的传播
  行为有进程级测试，普通路径不调用 `process.exit()`；
- 通过 pipe 捕获足够大的注入输出，证明 stdout/stderr 完整排空后进程才以目标 code 退出；
- `main()` 使用注入的 env/cwd/writer/dispatcher 测试，不修改全局 process state；
- `main()` 捕获注入的未预期异常，只输出有界摘要且不产生 unhandled rejection/stack；

从实际 npm tarball 的干净 prefix 在 macOS、Linux 验证：

```text
tinker --help
tinker --version
tinker help run
tinker run "release smoke"
tinker run --profile <fixture-profile> "release smoke"
printf 'release smoke' | tinker run --stdin
tinker run --file <temporary-utf8-file>
tinker doctor
tinker --unknown
tinker run --stdin --stdin
tinker run --file --stdin
```

缺配置 case 只能证明 config 在 Prompt source 之前 fast-fail，不能证明 stdin/file 已被
读取。三种 Prompt source 的正向证据必须注入完整离线配置和 `TINKER_TEST_FAKE_MODEL`，分别
证明 argument/stdin/file 的精确文本进入同一个 canonical user message。发布 smoke 不调用
真实 provider。

## 13. README 与迁移说明

README 的 one-shot 示例必须使用单个引用参数：

```bash
tinker run "explain the project structure"
```

并增加 stdin/file 示例和 shell 边界说明。

README 的 `PUBLIC CLI COMMANDS` marker 段落和 Commander command tree 必须共同消费
`public-cli-contract.ts` 的无副作用元数据；不得让 docs renderer 解析 help 文本，也不得在脚本
中手写第二份 command/option/usage 清单。安全说明、迁移说明和 shell quoting 示例仍属于 marker
外的人工 prose。

当前实现实际接受但 README 未推荐的形式：

```bash
tinker run explain the project structure
```

阶段一后将失败，因为它包含多个位置参数。不要保留自动 join fallback。CHANGELOG 必须把
它记录为 CLI 输入收紧，并提示用户加引号或改用 `--stdin`/`--file`。发布准备应按
`docs/releasing.md` 判断这项外部行为收紧对应的 SemVer，而不是把它当成内部重构。

## 14. 实施顺序

硬前置：先完成上位方案 P1.1，把 env/profile/tooling config resolution 上移到 CLI composition
root，形成第 8.2 节的 immutable snapshot 与 pure derive 边界。one-shot 接收派生后的
`RunnerConfig`，TUI 接收同一快照并按生命周期派生多个 config。未完成该前置时不得开始 P1.2，
也不得增加重复 config preflight。

1. 增加 Commander dependency、无副作用 `public-cli-contract.ts` 与
   `package-metadata.ts`。
2. 建立纯 command tree、重复/缺值消歧、输出注入、exit override、固定 usage hint 和
   post-parse invariant 测试。
3. 拆分可导入的 `main.ts` 与 guarded `index.ts`，建立 selected-command dynamic import，重构
   Node launcher 的 code/signal 传播，并让 TUI/one-shot lifecycle 不再调用 `process.exit()`。
4. 实现 `prompt-source.ts`、bounded stdin/file reader、errno 分类和安全错误 renderer。
5. 按 parse -> invariant -> config snapshot/derive -> Prompt source -> dispatch 接通 one-shot，
   并验证 TUI 多 session 派生不重新读取配置。
6. 实现 doctor，复用 production config、project-instruction、Agent Skills、MCP 和 project-command
   parser，落实 bundled/effective ripgrep 与固定输出状态机。
7. 更新 README、CHANGELOG、公共 docs renderer/checker 和发布 guide；CLI marker 只消费共享
   公共声明。
8. 扩展真实 tarball 的 macOS/Linux 正负向 smoke。
9. 运行完整质量门禁并回填本文实施结果。

不要先把 Commander action 直接连到现有 runner，再补输入和退出码测试；解析与副作用边界
必须从第一步就分开。

## 15. 完成定义

- [ ] `commander@^14.0.3` 与 Node `>=20` 安装合同一致。
- [ ] Commander 与 README renderer 消费同一份无副作用 CLI 声明，没有第二份 usage 清单。
- [ ] P1.1 已先完成 config 上移；每个 `tui`/`run` 进程只执行一次 public config resolution，
      one-shot 派生一次，TUI 从同一快照按 session 生命周期纯派生且不生成多余 session ID。
- [ ] config boundary 不 import provider/tool implementation；model client/refiner/runtime factory 只
      随 selected runner 加载。
- [ ] `main.ts`、`index.ts` 可安全 import，且 import `index.ts` 不加载 Commander；help/version/
      usage 不加载 TUI/runtime/tool/provider；config/Prompt 成功后才 dynamic import selected runner。
- [ ] Node launcher、Bun guard、`main()`、Commander 和 runner 的普通路径不调用
      `process.exit()`；TUI cleanup 与 stdout/stderr flush 完成后只设置 `process.exitCode`，child
      signal 仍以原 signal 传播。
- [ ] 所有已声明命令、help 和 version 在无 model 配置时行为确定。
- [ ] `--version` 输出裸 package version，Commander version getter 不含程序名前缀。
- [ ] 顶层/root action、`run [prompt]`、全部 help 成功 code 与当前 command 固定 usage hint 有
      精确测试。
- [ ] 未知 option、缺参数、多参数、重复逻辑 option、greedy option-looking value 和 source
      冲突在副作用前返回 `2`；attached leading-dash value 行为确定。
- [ ] 顶层 profile 与 run/doctor 的冲突由显式 post-parse invariant 返回 `2`。
- [ ] `run --profile`/`run -p` 为 one-shot 选择 profile，省略时使用 default profile/env mode。
- [ ] argument、stdin、file 恰好三选一，没有隐式 stdin 或 variadic join。
- [ ] public config failure 发生在 stdin/file 读取前，并与 usage/Prompt/runtime failure 使用固定
      exit-code 分类。
- [ ] Prompt 校验有 1 MiB 上限、fatal UTF-8、NUL 和非空合同。
- [ ] 合法 Prompt 的文本不 trim、不换行规范化、不追加换行。
- [ ] Prompt errno 映射、跨平台同义错误、stdin listener cleanup、路径控制字符与 512-byte
      detail 上限有精确测试。
- [ ] `runOneShot()` 不感知 Prompt source。
- [ ] `main()` 是总错误边界，未预期异常不泄漏 stack/secret，也不重复 runner 已输出的错误。
- [ ] doctor 只读、离线、脱敏，复用 production config/instruction/skill/project parser，不创建
      session identity、不启动 MCP 或执行 skill。
- [ ] doctor 的 Bun probe 接受等于或高于包声明基线的稳定版本，拒绝更低或不可识别版本。
- [ ] doctor 分别验证 bundled/effective ripgrep，覆盖固定九项检查、`SKIP` 依赖图、三条限制
      说明、最终 `RESULT` 行和 stderr failure count。
- [ ] README 和 CHANGELOG 说明 shell quoting、stdin/file 以及旧 variadic 行为移除。
- [ ] 真实 npm tarball 在 macOS、Linux 通过 CLI smoke。
- [ ] `bun run check`、`bun run release:verify`、`git diff --check` 完整通过。

## 16. 实施结果

待实现后回填：

- 完成 commit：待定。
- Commander/Bun package smoke：待定。
- macOS CLI smoke：待定。
- Linux CLI smoke：待定。
- 最终命令与 Prompt source 测试数：待定。
