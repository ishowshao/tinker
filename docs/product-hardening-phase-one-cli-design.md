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
3. Commander 不直接终止进程；顶层 `main()` 统一决定最终 exit code。
4. `run` 的 Prompt 来源固定为单个位置参数、`--stdin`、`--file <path>` 三选一。
5. 顶层 `--profile`/`-p` 属于默认 TUI 命令；`run` 声明自己的同名 option，用于选择
   one-shot profile。
6. 不隐式探测 piped stdin；读取 stdin 必须显式写 `--stdin`。
7. 位置参数只有一个，不再支持 `<prompt...>` 或空格拼接。
8. Prompt 只验证 UTF-8、字节上限、NUL 和非空性，不 trim、不规范化换行、不追加换行。
9. help、version、语法错误和 Prompt source 校验全部发生在任何 runtime 副作用之前。
10. CLI 结构错误和可预期的 Prompt 输入错误返回 `2`；运行或本地 I/O 故障返回 `1`。
11. one-shot 的 canonical user message 只保存最终 Prompt 文本，不增加 Prompt source 字段。

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
[Commander 官方文档](https://github.com/tj/commander.js/)为准。

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
- `.enablePositionalOptions()`，让顶层 option 只在子命令之前解析、子命令 option 在子命令
  之后解析；
- `.exitOverride()`，把 Commander 的终止转换为可分类错误；
- `.configureOutput()`，将输出写入注入的 stdout/stderr；
- `.parseAsync(args, { from: "user" })`。

不启用：

- `.allowUnknownOption()`；
- `.allowExcessArguments()`；
- stand-alone executable subcommands；
- 隐式 option pass-through；
- Commander lifecycle hook 承载 runtime 初始化。

Commander action 只记录解析后的 `CliCommand`，不能在 action 内创建 session 或执行
runner。这样所有命令先完成完整解析，再由 composition root dispatch。

Commander 的 option parsing 不能代替 Tinker 的 cross-command invariant。完成 parse 后、
读取配置或执行 command 前，必须显式验证：若顶层 `profile` 已设置且选中的 command 不是
`tui`，立即抛出 Tinker usage error 并映射为 exit `2`。`.enablePositionalOptions()` 不会拒绝
`tinker --profile kimi run "hello"`；它会把 `profile=kimi` 保留在顶层并正常选择 `run`，
因此不能依赖 Commander 自然失败。

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

profile name 必须是一个非空 argv 值，额外位置参数是 usage error。以下输入全部返回 `2`：

```bash
tinker --profile
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
```

不要让 Commander 自动接受多个 positionals，也不要在 parser 后拼接。

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

CLI 错误不得回显完整 Prompt。错误只报告 source kind、实际字节数、上限或文件路径；NUL、
无效 UTF-8 和空内容错误不附带正文预览。

## 8. 解析与执行架构

### 8.1 数据流

```text
bin/tinker.js
  -> Bun src/cli/index.ts
  -> load package metadata
  -> parseCommandLine(argv)
       -> help/version/usage terminal result
       -> CliCommand
  -> validate cross-command invariants
  -> command=tui/run: resolve public runtime config once
  -> command=run: resolve PromptSource
  -> command=doctor: runDoctor with production parsers as probes
  -> dispatch runTui(resolved config) / runOneShot(resolved config, Prompt)
```

关键顺序：

- package metadata 只读取安装包自身，不读取 workspace；
- 完整 argv parse 必须先于 Prompt source、配置和 runner；
- `run` 先完成语法解析，再加载 model 配置，最后读取 Prompt；三者都在 session 创建前完成；
- 缺少 model 配置时不得先等待 stdin EOF 或读取 Prompt 文件；
- runtime config 在 CLI composition root 只解析一次，runner 不再重复读取 env/profile；
- doctor 使用 production config parser，但不调用 runner；
- TUI 只在命令明确为 `tui` 后初始化。

该顺序依赖上位方案 P1.1 先完成配置所有权上移。当前
`src/cli/run-runner.ts` 的 `runOneShot()` 会在内部调用 `loadModelProfiles()` 和
`readRunnerConfig()`；P1.2 不得在 `main()` 增加一次相同 preflight 后仍让 runner 再解析。
P1.1 必须先提供一次解析得到的 runtime config，并让 one-shot/TUI runner 接收该结果，P1.2
才能在 config 通过后安全读取 stdin/file。

### 8.2 `CliCommand`

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

### 8.3 入口返回值

`src/cli/index.ts` 改为薄入口：

```ts
const exitCode = await main({
  args: process.argv.slice(2),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(exitCode);
```

`main()` 返回 exit code，不在深层函数调用 `process.exit()`。测试直接调用 `main()` 或纯
parser，不通过 monkey-patch 全局进程状态来断言。

Commander 的 `CommanderError` 必须按 `code` 分类，而不是通过英文 message 做字符串匹配。
help/version 是成功终止；未知 option、缺 argument、excess argument 和冲突 source 是
usage error。

## 9. 输出与退出码

| 情况 | stdout | stderr | exit code |
| --- | --- | --- | --- |
| help | Commander 渲染的帮助 | 空 | `0` |
| version | `<package-version>` 单行 | 空 | `0` |
| usage error | 空 | 单个错误和对应 usage hint | `2` |
| Prompt source 缺失、非 regular、超限、空、NUL 或编码无效 | 空 | 有界、无正文的输入错误 | `2` |
| Prompt stdin/file 在合法打开后的意外 I/O fault | 空 | 有界本地错误 | `1` |
| doctor 全部通过 | 检查项和最终 `PASS` | 空 | `0` |
| doctor 检查失败 | 已完成检查项 | 脱敏失败摘要 | `1` |
| TUI/one-shot runtime failure | 保持 runner 产品输出 | 运行错误 | `1` |

Commander 默认的 usage error exit code 可能不是 Tinker 合同值；入口必须统一映射为 `2`。
不要让 library default 决定产品 exit code。

输出 writer 由依赖注入提供。测试使用内存 writer；生产传入 process stdout/stderr。

## 10. `tinker doctor`

### 10.1 目的与边界

doctor 回答“当前安装和本地配置能否进入 session 创建阶段”，不回答“远端 provider 是否
可用”。它必须只读、离线、确定：

- 不调用 model 或 token estimator；
- 不启动 MCP server；
- 不创建 session、asset、history 或 workspace 文件；
- 不修复配置和权限；
- 不输出 API key、profile secret 或 `.mcp.json` 的 env 内容。

### 10.2 固定检查顺序

1. **package**：安装根 package name 是 `tinker-agent`，version 非空，bin 只暴露
   `tinker`。
2. **bun**：当前入口运行在 Bun 下，且 runtime version 按 SemVer precedence 大于等于实际
   安装包 `dependencies.bun` 声明的版本。该依赖必须是可解析的精确稳定版本，作为最低兼容
   基线，不能在 doctor 源码中复制版本常量。发布入口会启动包内 Bun，通常精确命中；源码
   开发使用兼容的较新 Bun 也必须 `PASS`，低于基线、pre-release 或无法识别版本才 `FAIL`。
3. **ripgrep**：解析包内 `@vscode/ripgrep` executable，运行 `--version` 且 exit `0`。
4. **workspace**：按 production 规则解析 workspace，realpath 存在且是可读目录；不写
   `.tinker`。
5. **model config**：调用 production parser 验证 profile/env mode 和 context budget；
   secret 只报告 configured/missing。
6. **project config**：存在时用 production parser 验证 `.mcp.json` 与 `.tinker.json`，但
   不连接或执行。
7. **result**：无 `FAIL` 才返回 `0`。

各项输出 `PASS`、`FAIL` 或因前置依赖失败产生的 `SKIP`。独立检查尽量继续，一次显示多个
本地问题。最终提示必须明确：

```text
Provider connectivity was not checked.
```

### 10.3 实现所有权

`src/cli/doctor.ts` 依赖 production parser 和可注入 package/runtime probes。不得从
`runTui()` 或 `runOneShot()` 中途截断来模拟 doctor，因为 runner 会跨入 session、model、
skills 和 MCP 等有副作用的边界。

## 11. 模块拆分

| 文件 | 责任 |
| --- | --- |
| `src/cli/command-line.ts` | 创建 Commander 实例、定义 command tree、解析成 `CliCommand` |
| `src/cli/prompt-source.ts` | 三种来源、bounded read、UTF-8/NUL/空内容校验 |
| `src/cli/package-metadata.ts` | 从实际安装包读取 name/version/bin identity 与 Bun 最低兼容基线 |
| `src/cli/doctor.ts` | 只读离线检查和脱敏报告 |
| `src/cli/index.ts` | `main()` composition、一次 config resolution 与最终 dispatch |
| `src/cli/run-runner.ts` | 接收 resolved `RunnerConfig` 和 Prompt string；不理解 Prompt source，也不再加载 env/profile |
| `src/__tests__/command-line.test.ts` | 命令语法、help/version、Commander error mapping |
| `src/__tests__/prompt-source.test.ts` | argument/stdin/file 的边界、保持与失败 |
| `src/__tests__/doctor.test.ts` | 检查顺序、状态、无副作用和脱敏 |
| `scripts/verify-release-package.ts` | 从真实 tarball 验证公共 CLI |

`src/agent`、`src/context`、`src/session` 和 TUI 不应因本文改变语义。

## 12. 测试方案

### 12.1 Commander parser

- 空 argv -> TUI；
- `--profile`/`-p` 合法、缺值、多值；
- `run --profile`/`run -p` 对 argument/stdin/file 均可用，并把 profile 记录在 run command；
- `run` 未指定 profile 时保持 default profile/env mode，未知 profile 和 env mode 下显式
  profile 在 config boundary fast-fail；
- 精确覆盖 `--profile kimi run "hello"`、`--profile kimi doctor`：Commander parse 可成功，
  但 Tinker post-parse invariant 必须在配置和 runner 前返回 `2`；
- `run` 三种合法来源；
- 缺 source、source 冲突、excess positional；
- `--` 后以 `-` 开头的单 Prompt；
- 顶层和子命令未知 option；
- 顶层、run、doctor help；
- `--version`/`-V`；
- help/version/usage error 不加载 workspace 或 config；
- 每次测试创建新的 Commander 实例，无状态泄漏。

### 12.2 Prompt source

- argument 保留空格、tab、换行、引号、反斜杠、emoji 和前后空白；
- stdin chunk 边界跨越多字节 UTF-8 code point；
- file 通过同一 handle 读取；
- CRLF、末尾换行和 BOM 保持；
- 1 MiB 精确边界成功，超过一个字节失败；
- invalid UTF-8、NUL、空字符串和纯空白失败；
- file missing、permission、directory、FIFO 失败；
- stdin/file 错误不包含正文或 secret；
- 多 source 在任何读取前失败。

### 12.3 Doctor

- 完整 env mode、text profile、image profile；
- 缺配置、错误 budget、未知 profile 字段；
- workspace 不存在；
- 无/合法/损坏 `.mcp.json` 与 `.tinker.json`；
- Bun runtime 等于或高于 `dependencies.bun` 时成功，低于基线、pre-release、非法版本或非
  Bun runtime 时失败；
- bundled ripgrep probe 成功与失败；
- 输出不含注入的 API key 和 MCP secret；
- 不创建 `.tinker`，不发网络请求，不启动 MCP。

### 12.4 入口进程与发布包

从实际 npm tarball 的干净 prefix 在 macOS、Linux 验证：

```text
tinker --help
tinker --version
tinker run "release smoke"
tinker run --profile <fixture-profile> "release smoke"
printf 'release smoke' | tinker run --stdin
tinker run --file <temporary-utf8-file>
tinker doctor
tinker --unknown
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

当前实现实际接受但 README 未推荐的形式：

```bash
tinker run explain the project structure
```

阶段一后将失败，因为它包含多个位置参数。不要保留自动 join fallback。CHANGELOG 必须把
它记录为 CLI 输入收紧，并提示用户加引号或改用 `--stdin`/`--file`。发布准备应按
`docs/releasing.md` 判断这项外部行为收紧对应的 SemVer，而不是把它当成内部重构。

## 14. 实施顺序

硬前置：先完成上位方案 P1.1，把 env/profile config resolution 上移到 CLI composition root，
并让 TUI/one-shot runner 接收 resolved config。未完成该前置时不得开始 P1.2，也不得增加
重复 config preflight。

1. 增加 Commander dependency 与 `package-metadata.ts`。
2. 建立纯 command tree、输出注入、exit override 和 post-parse invariant 测试。
3. 实现 `prompt-source.ts` 及 bounded stdin/file reader。
4. 将 `index.ts` 改为 parse -> invariant -> config -> Prompt source -> dispatch。
5. 实现 doctor，复用 production config/project parsers。
6. 更新 README、CHANGELOG、公共 docs checker 和发布 guide。
7. 扩展真实 tarball 的 macOS/Linux smoke。
8. 运行完整质量门禁并回填本文实施结果。

不要先把 Commander action 直接连到现有 runner，再补输入和退出码测试；解析与副作用边界
必须从第一步就分开。

## 15. 完成定义

- [ ] `commander@^14.0.3` 与 Node `>=20` 安装合同一致。
- [ ] P1.1 已先完成 config 上移；one-shot/TUI runner 不重复解析 env/profile。
- [ ] 所有已声明命令、help 和 version 在无 model 配置时行为确定。
- [ ] `--version` 输出裸 package version，Commander version getter 不含程序名前缀。
- [ ] 未知 option、缺参数、多参数和 source 冲突在副作用前返回 `2`。
- [ ] 顶层 profile 与 run/doctor 的冲突由显式 post-parse invariant 返回 `2`。
- [ ] `run --profile`/`run -p` 为 one-shot 选择 profile，省略时使用 default profile/env mode。
- [ ] argument、stdin、file 恰好三选一，没有隐式 stdin 或 variadic join。
- [ ] Prompt 校验有 1 MiB 上限、fatal UTF-8、NUL 和非空合同。
- [ ] 合法 Prompt 的文本不 trim、不换行规范化、不追加换行。
- [ ] `runOneShot()` 不感知 Prompt source。
- [ ] doctor 只读、离线、脱敏，并复用 production parser。
- [ ] doctor 的 Bun probe 接受等于或高于包声明基线的稳定版本，拒绝更低或不可识别版本。
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
