# TUI 真实 PTY Harness 与端到端测试方案

## 文档状态

- 状态：阶段 A（Harness 基础）、阶段 B（P0）和全部 P1 用例已实施；P2 与阶段 E
  待实施。
- 日期：2026-07-24。
- 范围：TUI 真实 PTY harness、确定性测试依赖和关键用户旅程。
- 当前基线：PTY-001 至 PTY-008、PTY-101 至 PTY-112 已通过共享 harness
  进入默认测试门禁。

本文定义 Tinker 后续真实 PTY 自动化测试的共同基础和分阶段测试清单。它不把现有
Ink 组件测试重复搬到更慢的进程测试中，而是验证用户通过真实终端完成一段操作后，
界面、runtime、session、文件系统和进程生命周期是否共同得到正确结果。

## 1. 结论

真实 PTY 测试必须从公开入口 `node bin/tinker.js` 启动完整 Tinker 进程，通过 PTY
发送真实按键，并等待 Ink 实际写出的终端画面。除远程 provider 和少数不可控外部
服务外，不替换 CLI、配置加载、TUI、RuntimeSession、SessionStore、工具注册、文件
系统或退出清理。

测试结果不能只靠“累计 stdout 中曾经出现过某段文字”判定。Harness 必须同时提供：

1. 当前终端画面，用于判断用户此刻真正看到的内容；
2. 完整终端 transcript，用于观察短暂出现的 running、cancelling 等状态；
3. 进程退出状态；
4. workspace、SQLite、剪贴板和子进程等持久化或外部副作用的检查入口。

第一批已经把已有 `/quit` 用例迁移到统一 harness，并补齐普通双轮对话、`Esc`
取消、工具调用、后台任务清理、正常 `/resume` 和异常中断恢复。P1 已继续覆盖输入交互、
session 命令、context、图片、Skills 和 MCP。P0/P1 已全部进入默认 `bun run check`；
后续扩展 P2 的 session 保护、终端边界和图片 admission maintenance。

## 2. 背景与问题

Tinker 已经有较完整的分层测试：

- `ink-testing-library` 覆盖 PromptInput、picker、viewer、Timeline 和 App 命令路由；
- runtime 和 session 测试覆盖 turn、取消、持久化、恢复、context revision 和工具协议；
- CLI 测试覆盖参数解析、one-shot 和真实 Node launcher；
- `src/__tests__/cli-pty.test.ts` 使用真实 PTY 验证 `/quit` 会让完整进程退出。

这些测试仍不能替代真实 PTY 用户旅程。Ink 的 raw mode、ANSI cursor 控制、stdin
暂停、`waitUntilExit()`、Bun 事件循环、子进程组和终端尺寸都可能只在真实 TTY 下
暴露问题。此前 `/quit` 已经证明：组件层 `exit()` 正确，不代表完整 TUI 进程一定会
回到 shell。

当前 PTY 用例的结构是：

```text
bun test
  -> python3 src/__tests__/fixtures/pty-host.py
     -> pty.fork()
        -> node bin/tinker.js
           -> bundled Bun
              -> CLI -> Ink App -> RuntimeSession
```

这条路径是真实的，但阶段 A 实施前的 harness 有以下限制：

1. PTY 启动、等待、退出和清理逻辑全部写在单个测试文件中，无法复用；
2. 测试把所有终端字节追加到一个字符串，再使用 `includes()` 判断，无法区分旧画面
   与当前画面；
3. `pty-host.py` 只在启动时固定为 `30 x 120`，运行中不能 resize；
4. 没有 Enter、Esc、方向键、Tab、bracketed paste 和鼠标事件等语义化输入接口；
5. fake model 只有少量独立模式，缺少跨多个 request 的用户旅程状态机；
6. 失败诊断没有当前屏幕、完整 transcript、child 状态和 workspace 位置的统一快照；
7. 除进程退出外，没有统一检查 SQLite、文件、后台 PID 和其他 durable state。

## 3. 目标

- 建立一个可复用、可诊断、可 resize 的真实 PTY harness。
- 从公开 CLI 入口驱动真实 Tinker，而不是直接调用 React handler 或 runtime 方法。
- 用确定性的 fake model 替换远程 provider，同时保留真实 agent loop 和工具执行。
- 以用户旅程为测试单元，覆盖连续使用、取消、恢复、session 控制和退出清理。
- 每条测试同时验证用户可见结果和至少一个跨层结果。
- 所有默认门禁用例完全离线，不依赖用户配置、真实凭证或公网。
- macOS 和 Linux 使用相同的 P0/P1 合同。
- 失败时给出足够证据，不需要本地重新跑一次才能知道卡在哪个阶段。

## 4. 非目标

- 不用 PTY 重测每一个 parser 分支、组件排版细节或工具边界条件。
- 不用全屏 golden snapshot 锁死空格、颜色、spinner 帧或相对时间。
- 不把真实 provider smoke 放进默认 `bun run check`。
- 不自动测试 WebSearch 或远程 WebFetch；它们仍由独立工具测试和显式 live smoke
  覆盖。
- 不承诺 Windows PTY；当前产品和 Bash runtime 仍以 POSIX 为边界。
- 不为测试建立通用模型脚本语言。Fake model 使用少量、显式、可审查的命名场景。
- 不通过直接写 SQLite 构造普通成功路径。正常 session 必须由前一段真实 PTY 操作
  产生。
- 不在当前 TUI 尚未支持 token 级增量渲染时提前写对应 PTY 合同；该功能落地后再
  增加独立用例。

## 5. “真实 PTY 端到端”的边界

默认 PTY suite 中以下部分必须是真实实现：

- `bin/tinker.js` Node launcher 和包内 Bun 启动；
- CLI 参数与环境配置解析；
- project instructions、`.tinker.json`、Skills 和 `.mcp.json` 加载；
- Ink render、raw stdin、窗口尺寸和按键解析；
- App、TuiSessionController、RuntimeSession、agent loop 和 event projection；
- SessionStore、SessionCatalog、resume projection 和 workspace `.tinker` 数据；
- Read、Write、Edit、Bash、TaskList、TaskOutput、TaskStop、Recall 和 Skill；
- 本地 stdio MCP server 进程；
- 文件、图片资产、Bash log 和后台进程组；
- `/quit` 后的 runtime dispose、stdin 恢复和最终进程退出。

以下边界允许使用确定性测试实现：

- 远程模型 HTTP API；
- 图片 token estimator HTTP API；
- MCP 的远程实现，改用仓库内 stdio fixture；
- 系统剪贴板，默认门禁改用确定性的 test-only sink；另在支持桌面 session 的 macOS
  lane 验证真实剪贴板。

Fake model 不是 fake runner。每个模型输出仍必须经过正常 model request、agent loop、
tool call、observation、canonical persistence 和 TUI event 路径。

## 6. Harness 总体设计

### 6.1 文件布局

建议落点：

```text
src/__tests__/
  cli-pty.test.ts                 # P0 核心旅程和已有 /quit
  pty-tui-harness.test.ts         # screen、输入编码、控制协议和诊断
  cli-pty-session.test.ts         # resume、clear、fork、model、delete
  cli-pty-input.test.ts           # Prompt、slash、@、viewer、图片
  cli-pty-extensions.test.ts      # context、Skills、MCP、copy
  cli-pty-terminal.test.ts        # resize、宽字符、鼠标
  helpers/
    pty-tui-harness.ts            # 进程、环境、等待、断言与清理
    pty-terminal-screen.ts        # 当前 VT screen 投影
  fixtures/
    pty-host.py                   # 真实 PTY 与 resize 控制
    fake-mcp-server.ts            # 复用现有 stdio MCP fixture
```

`cli-pty.test.ts` 保留为核心入口，避免先做无价值的文件重命名。只有共享逻辑进入
`helpers/`，测试场景本身留在对应 test 文件中。

### 6.2 进程拓扑

```text
Bun test process
  ├─ temporary home
  ├─ temporary workspace
  ├─ VT screen emulator
  └─ python3 pty-host.py
       ├─ stdin/stdout: PTY bytes
       ├─ stderr: host diagnostics
       ├─ local control socket: resize/signal JSON Lines
       └─ pty child process group
            -> node bin/tinker.js
               -> bundled Bun
                  -> full Tinker TUI
```

测试进程不能绕过 `bin/tinker.js` 直接运行 `src/cli/index.ts`。真实 public launcher 是
端到端边界的一部分。

### 6.3 TypeScript Harness 接口

建议接口如下，实际命名可以微调，但能力不能减少：

```ts
type PtyKey =
  | "enter"
  | "escape"
  | "tab"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "page_up"
  | "page_down"
  | "ctrl_a"
  | "ctrl_d"
  | "ctrl_e"
  | "ctrl_u";

type StartPtyTuiInput = {
  readonly fakeModel: string;
  readonly rows?: number;
  readonly columns?: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly workspaceFiles?: Readonly<Record<string, string | Uint8Array>>;
  readonly homeFiles?: Readonly<Record<string, string | Uint8Array>>;
};

type PtyProcessExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

interface PtyTuiHarness {
  readonly workspaceRoot: string;
  readonly homeRoot: string;

  type(text: string): Promise<void>;
  paste(text: string): Promise<void>;
  press(key: PtyKey): Promise<void>;
  mouseWheel(direction: "up" | "down", x?: number, y?: number): Promise<void>;
  resize(rows: number, columns: number): Promise<void>;

  screenText(): string;
  transcriptText(): string;
  markTranscript(): number;
  transcriptSince(mark: number): string;

  waitForScreen(
    predicate: string | RegExp | ((screen: string) => boolean),
    options?: { timeoutMs?: number; message?: string },
  ): Promise<void>;
  waitForTranscript(
    predicate: string | RegExp | ((output: string) => boolean),
    options?: { since?: number; timeoutMs?: number; message?: string },
  ): Promise<void>;

  signalTui(signal: NodeJS.Signals): Promise<void>;
  waitForExit(timeoutMs?: number): Promise<PtyProcessExit | undefined>;
  wrapperExit(): PtyProcessExit | undefined;
  tuiExit(): PtyProcessExit | undefined;
  diagnosticText(expectedCondition: string): string;
  dispose(): Promise<void>;
}
```

普通单进程 case 使用 `withPtyTui()` 包住场景主体；它始终调用 `dispose()`，并在场景和
清理同时失败时用 `AggregateError` 保留两边证据。需要显式管理多个前后进程或验证
temporary root 清理本身时，才直接使用底层 `startPtyTui()`。

`type()` 发送普通 UTF-8 字节；`paste()` 必须发送真实 bracketed paste 边界；`press()`
统一维护按键 escape sequence，测试文件不自行散落 `\x1b[A` 等常量。

### 6.4 PTY host 控制协议

继续使用 Python 标准库 `pty.fork()`，不引入 native `node-pty` 编译依赖。`pty-host.py`
保持三条通道分离：

- stdin/stdout 只传 TUI 的 PTY 字节；
- stderr 只写 host 异常和诊断；
- temporary root 内权限为 `0600` 的本机 Unix domain socket 接收 JSON Lines 控制消息，
  并返回确认。

控制通道不使用 Bun `child_process` 的额外双工 stdio fd。该 fd 在快速退出时可能先于
末尾 child 状态消息关闭，无法稳定证明 wrapper 与 TUI child 都已退出。Unix domain
socket 仍是独立的本机 fd 通道，不混入 PTY stdout 或 host stderr，并在 host 退出时由
双方关闭和删除。

第一版控制消息需要：

```json
{"op":"resize","rows":20,"columns":80}
{"op":"signal_child","signal":"SIGKILL"}
```

Host 收到后执行 `TIOCSWINSZ`，向 PTY child process group 发送 `SIGWINCH`，完成后
返回带相同 rows/columns 的确认。`resize()` 必须等确认后才能 resolve，不能靠固定
sleep 猜测窗口已经改变。

`signal_child` 只供 crash/interrupted 测试使用。Host 必须先返回已接受确认，再向 Tinker
child 发送信号，并继续负责 `waitpid()`；测试不能通过杀死 Python wrapper 来模拟 Tinker
崩溃，否则 wrapper 无法回收或报告真实 child 状态。

Host 的 signal handler 必须清理完整 child process group。测试结束时先等待正常退出，
再发送 `SIGTERM`；超时后才允许 `SIGKILL`。所有路径都要 `waitpid()`，不能留下 zombie。

### 6.5 当前终端画面

Harness 必须把 PTY stdout 同时送到：

1. append-only transcript；
2. 一个真正维护 cursor、erase 和 viewport 的 headless VT screen emulator。

不能用 `strip-ansi` 代替 screen emulator。删除 ANSI 只能得到历史字符流，无法解释
Ink 常用的 cursor up、erase line、carriage return 和重绘；这正是当前测试可能误匹配
旧画面的根因。

VT 实现必须至少正确处理：

- CR、LF、backspace 和 tab；
- CSI cursor movement 和 cursor position；
- erase line、erase display；
- SGR，可忽略样式但必须正确消费参数；
- show/hide cursor、mouse mode 和 bracketed paste mode；
- viewport resize；
- UTF-8、组合字符和宽字符列宽。

实现使用 test-only 的 `@xterm/headless` 和 `@xterm/addon-unicode11`，并封装在
`pty-terminal-screen.ts` 后面。不要在仓库里手写一个只够当前 `/quit` 通过的不完整 ANSI
parser。这两个依赖作为 devDependency 锁入 `bun.lock`，生产包不依赖它们。

`screenText()` 返回当前 viewport 的纯文本投影，移除每行尾部空格和末尾全空行，但不
折叠普通正文中的内部空格。对于会因终端宽度换行的 notice，测试可以通过专用
`normalizeScreenWhitespace()` 做语义匹配；文件内容和 Prompt 内容仍使用精确断言。

### 6.6 Transcript 的使用边界

当前画面是最终状态断言的默认来源。Transcript 只用于以下短暂状态：

- `Running`；
- `cancelling`；
- 工具从 running 进入 completed/failed；
- loading picker 或 loading viewer；
- 进程退出前最后一个 frame。

测试必须在触发动作前调用 `markTranscript()`，然后只检查该 mark 之后的新输出，避免
命中更早的同名文本。最终回答、当前 session、picker 选择项和错误恢复必须检查
`screenText()`。

### 6.7 输入编码

Harness 统一发送以下真实终端字节：

| 操作 | 字节 |
| --- | --- |
| Enter | `\r` |
| Esc | `\x1b` |
| Tab | `\t` |
| Up/Down/Left/Right | CSI arrow sequence |
| Home/End | xterm Home/End sequence |
| PageUp/PageDown | xterm `~` sequence |
| Ctrl+A/D/E/U | 对应 C0 control byte |
| Bracketed paste | `\x1b[200~` + UTF-8 内容 + `\x1b[201~` |
| Mouse wheel | SGR mouse sequence |

测试不应一次性写入“文本 + Enter”来掩盖 key parsing 问题。普通文本和提交按键应由
两个明确调用完成。

### 6.8 环境隔离

每个测试创建独立的 temporary home 和 workspace。基础环境构造器必须：

- 删除继承的全部 `TINKER_*` 和 `EXA_API_KEY`；
- 删除 `CI`，保证 Ink 使用真实交互路径；
- 设置 `HOME`、`TINKER_WORKSPACE`、`NO_COLOR=1` 和 `TERM=xterm-256color`；
- 设置完整离线模型配置和 `TINKER_TEST_FAKE_MODEL`；
- 不读取用户真实 `.env`、`.tinker`、`.agents`、`.mcp.json` 或模型 profile；
- 为需要的测试显式创建 `.tinker.json`、`.mcp.json`、Skills 和 profile 文件；
- 保留运行 Node、Python、Bun、shell 和测试命令所需的最小 PATH。

测试退出后删除 temporary roots。测试失败时先生成诊断，再清理；诊断文本要包含临时
路径，使开发者可以在本地选择保留 fixture 复现，但 CI 不能默认泄漏临时数据。

### 6.9 确定性 FakeModel 场景

保留 `TINKER_TEST_FAKE_MODEL=<mode>` 入口，在 `FakeModelClient` 内增加少量显式模式。
不要解析一套自由 JSON 脚本。每个模式是一个小型状态机，并对收到的 messages、tools
和 session 状态 fail-fast。

建议场景：

| Mode | 用途 |
| --- | --- |
| `pty-echo-history` | 两轮对话，第二轮验证第一轮 user/assistant 已进入请求 |
| `pty-cancel-then-echo` | 第一轮等待 AbortSignal，取消后第二轮正常完成 |
| `pty-tool-chain` | 顺序调用 Write、Edit、Bash，再返回最终回答 |
| `pty-background-task` | 启动后台 Bash，调用 TaskOutput/TaskStop |
| `pty-interrupted-tool` | 完成一次有副作用工具后阻塞，供 SIGKILL 恢复测试使用 |
| `pty-fail-once` | 第一次 provider request 失败，下一轮成功 |
| `pty-context-heavy` | 产生足够大的真实工具 observation，供 compact/retire 使用 |
| `pty-skill-activate` | 调用 Skill，并验证激活后的 system surface |
| `pty-mcp-call` | 查找并调用 `mcp__fixture__echo` |
| `pty-image` | 验证 user attachment、materialization 和图片计数 |

会跨 `/resume` 的场景不能只依赖 FakeModelClient 内存中的 `steps` 计数，因为重启后会
创建新的 model client。它们必须从收到的 canonical messages、active skills 或明确的
测试 Prompt marker 推导下一步行为。

每个场景返回稳定、唯一的 marker，例如 `PTY_TURN_ONE_DONE`，方便等待；marker 只用于
同步，用户可见结构仍要检查 Timeline、Footer 和 durable state。

图片场景需要补齐当前 fake model 的测试能力：

- `inputModalities` 跟随所选 profile，而不是永远固定为 text；
- image profile 使用确定性的本地 `InputTokenEstimator`；
- `prepare()` 正确统计 media occurrence，并生成 media prompt segments；
- `materialize()` 通过真实 ImageAssetStore 读取并校验测试图片，但不发送网络请求。

这些是测试 model adapter 的能力，不得改变正式 OpenAI adapter 合同。

### 6.10 其他 fixture

- MCP：复用 `src/__tests__/fixtures/fake-mcp-server.ts`，通过真实 stdio transport 启动。
- Skill：在 temporary workspace 写入最小合法 `.agents/skills/<name>/SKILL.md`。
- 图片：使用仓库内固定的小型 PNG/JPEG/WebP fixture；不在测试运行时下载。
- 后台进程：命令写出自己的 PID 和唯一 marker，再保持运行，便于退出后验证 PID 不再
  存活。
- Clipboard：默认 suite 通过 `TINKER_TEST_CLIPBOARD_FILE=<absolute-path>` 注入 test-only
  file sink。该变量只能在 `TINKER_TEST_FAKE_MODEL` 已启用时由 TUI composition root 读取，
  未启用 fake model 时设置它必须 fail-fast。另在支持系统剪贴板的 macOS lane 中读取
  旧值、执行 `/copy`、验证新值，并在 `finally` 恢复旧值；真实 clipboard case 必须串行。

### 6.11 Durable state 断言

用户可见文本不能单独证明跨层结果。不同场景至少增加以下一种检查：

- 文件工具：读取 workspace 文件并核对精确内容；
- session：通过 SessionCatalog、SessionHistoryReader 或现有 session reader 检查 turn、
  model、最终回答和状态；
- `/fork`：检查 source/clone 各自的 SQLite 内容和独立后续 turn；
- `/copy`：读取系统剪贴板的精确 Markdown；
- 图片：检查 workspace image asset 和 canonical attachment；
- background task：确认 PID/进程组已经退出，log 已 flush；
- MCP：fixture 写入一次调用记录，核对参数和调用次数；
- Skill：检查 canonical activation 和恢复后的 active snapshot。

优先使用正式 domain reader。只有需要验证 clone identity、行数或外键等未暴露不变量时，
才直接查询 SQLite；不把直接 SQL 作为普通用户流程的驱动方式。

### 6.12 等待、超时与失败诊断

禁止用固定长 sleep 代表状态完成。所有等待都轮询可观察条件：当前 screen、transcript、
进程退出、文件存在、session catalog 或 host resize ack。

默认建议：

- 初始 TUI frame：10 秒；
- 普通 UI 状态变化：5 秒；
- `/quit` 正常退出：继续保持 2 秒回归合同；
- background/task cleanup：5 秒；
- 单个测试总超时：20 到 30 秒，按场景显式设置。

超时时统一输出：

```text
scenario
expected condition
current screen
last 8 KiB transcript
pty-host stderr
wrapper/child exit state
rows x columns
workspaceRoot
homeRoot
```

不为 PTY 用例增加自动 retry。出现偶发失败时修正等待条件、fixture 或产品竞态，不能用
重试掩盖。

### 6.13 清理合同

每个测试的 `finally` 必须调用 harness `dispose()`。清理顺序固定为：

1. 如果 TUI 可交互，优先提交 `/quit`；
2. 等待 bounded 正常退出；
3. 仍存活则对 PTY host 发送 `SIGTERM`；
4. 再次 bounded 等待；
5. 最后安全网才发送 `SIGKILL`；
6. wait host 和 child，关闭全部 pipe；
7. 验证登记过的后台 PID 不再存活；如果仍存活，先记录产品清理失败，再由 harness
   使用 bounded SIGTERM/SIGKILL 作为安全网，绝不能把测试进程留在机器上；
8. 恢复系统剪贴板等共享外部状态；
9. 删除 temporary roots。

测试主体若已经失败，清理错误应通过 `AggregateError` 或追加诊断保留，不能覆盖原始失败。

## 7. 测试用例设计原则

每条真实 PTY 测试都用“用户动作 -> 用户可见结果 -> durable result -> 可继续性”描述。

最低要求：

1. 至少发送一次真实按键；
2. 至少检查一次当前 screen；
3. 除纯退出或纯导航测试外，至少检查一个 TUI 外部结果；
4. 若进程没有退出，最后再提交一个操作，证明界面没有被锁死；
5. 不匹配随机 UUID、relative time 或 worked duration 的完整字面值；先捕获动态值，再用于
   后续断言；
6. 不把整个 ANSI transcript 存成 golden snapshot；断言稳定的语义块和 durable state。

## 8. P0：默认门禁的第一批用例

实施状态：PTY-001 至 PTY-008 已完成（2026-07-24），无 skip、无 retry。

### PTY-001：空闲 `/quit` 正常退出

- 用户视角：启动 Tinker 后输入 `/quit`，应在两秒内回到 shell，退出码为 `0`。
- 操作：等待初始 `Tinker` frame，输入 `/quit`，确认 suggestion/输入可见，按 Enter。
- Screen/transcript：提交前能看到 `/quit` 对应命令，退出前没有 runtime failure。
- Durable result：wrapper 和完整 TUI child 都退出，无遗留进程。
- 状态：当前已有测试；实施 harness 时先迁移且保持红绿能力不变。

### PTY-002：连续两轮普通对话

- 用户视角：完成第一轮后无需重启即可继续第二轮，第二轮能使用第一轮上下文。
- 操作：提交 `PTY_FIRST`，等待最终回答；再提交 `PTY_SECOND`。
- Screen：两条 user Prompt 和两个 final answer 都在 Timeline，Footer 最终可用。
- Durable result：SQLite 有两个 completed turns；第二次 fake request 已验证第一轮
  user/assistant messages 存在。
- 可继续性：最后执行 `/status` 或第三条短 Prompt，证明输入仍可用。

### PTY-003：`Esc` 取消后继续工作

- 用户视角：模型卡住时按 `Esc` 只取消当前 turn，不退出 TUI，随后可以继续提问。
- 操作：第一轮进入 `pty-cancel-then-echo` 阻塞状态，按 Esc；完成取消后提交第二轮。
- Transcript：本轮出现 Running、cancelling 和 cancelled 顺序。
- Screen：取消后仍是同一个 session，第二轮得到最终回答。
- Durable result：第一轮以 cancelled terminal state 持久化，第二轮 completed；消息协议验证
  通过。

### PTY-004：真实工具调用与 workspace 副作用

- 用户视角：要求 agent 创建、修改文件并运行命令，界面显示的结果必须与磁盘一致。
- 操作：`pty-tool-chain` 顺序调用 Write、Edit 和 Bash，再返回 final answer。
- Screen：Timeline 能看到工具 running/completed、Diff、Bash command/output 和 final answer。
- Durable result：目标文件内容精确匹配，Bash exit code 为 0，session 存有对应 tool
  calls/results。
- 可继续性：提交读取该文件的下一轮，fake model 验证历史工具 batch 完整。

### PTY-005：后台任务管理与退出清理

- 用户视角：长期服务进入后台后 TUI 仍可使用；退出 Tinker 时服务不会留在机器上。
- 操作：启动写 PID 的后台 Bash，等待 background panel；通过模型调用 TaskOutput，再调用
  TaskStop。第二个变体保留任务运行并直接 `/quit`。
- Screen：任务 ID、running/stopping/terminal status 和输出摘要可见，Prompt 在 turn 完成后
  可再次使用。
- Durable result：TaskStop 变体和 `/quit` 变体中 PID 都不再存活，日志已 flush，退出码
  正确。

### PTY-006：正常退出后通过 picker `/resume`

- 用户视角：退出再打开后，可以通过键盘选择旧 session，历史完整出现并继续工作。
- 操作：进程 A 完成含工具结果的一轮并 `/quit`；进程 B 启动，输入 `/resume`，用方向键或
  `j/k` 选择旧 session 并 Enter。
- Screen：picker 显示 prompt preview、model、turn count 和 resumable 状态；恢复后 Header
  session ID 与进程 A 一致，Timeline 保留 user/tool/final 结构。
- Durable result：恢复后追加的新 turn 写入同一个 session，而不是启动时创建的临时
  session。

### PTY-007：异常终止后的 interrupted session 恢复

- 用户视角：Tinker 在已经执行过一次副作用后崩溃，重启可以恢复，不会重复执行工具。
- 操作：`pty-interrupted-tool` 先完成一次带唯一 marker 的 Write，再阻塞下一次 model
  request；测试通过 host control channel 只向 Tinker child 发送 SIGKILL。新进程打开
  `/resume` 并选择 interrupted session。
- Screen：picker 清楚显示 interrupted；恢复后的 Timeline 保留已完成工具结果和中断
  terminal state。
- Durable result：唯一副作用只发生一次，没有自动重试原 tool call；追加新 turn 成功。

### PTY-008：一次失败后无需重启

- 用户视角：provider 或工具失败后，错误可见，但 TUI 没有永久锁住。
- 操作：`pty-fail-once` 第一轮抛出 provider failure；第二轮返回正常回答。工具失败另由
  `pty-tool-chain` 的明确失败分支覆盖。
- Screen：第一轮 Footer/Timeline 显示 failed 和有界错误，第二轮正常 completed。
- Durable result：两个 terminal turn 都已持久化，失败没有留下 open frame。

## 9. P1：核心产品功能用例

实施状态：PTY-101 至 PTY-112 已完成（2026-07-24），无 skip、无 retry。

### PTY-101：多行粘贴、光标编辑与 Prompt 历史

- 用户视角：粘贴多行中文或代码、移动光标编辑并提交时，模型收到的内容与画面一致；
  完成后可以用上下键找回历史。
- 操作：发送 bracketed paste，使用 Ctrl+A/E/U 和方向键修改，提交；再用 Up/Down 浏览、
  修改和重新提交。
- 断言：fake model 收到精确换行和 Unicode；历史恢复的原草稿、编辑后内容和最终提交都
  符合 PromptInput 合同。

### PTY-102：slash command 键盘发现与执行

- 用户视角：输入 `/` 后可以用方向键选择、Tab 补全、Enter 执行，Esc 只关闭候选。
- 操作：分别覆盖 Tab、Enter、Up/Down 和 Esc；至少实际执行一个无副作用命令。
- 断言：当前 screen 的选中项随按键变化；最终执行的是用户选中的命令，而不是原始前缀。

### PTY-103：`@` 文件选择与项目自定义命令

- 用户视角：输入 `@` 能选中真实 workspace 文件并插入无引号相对路径；项目命令能把
  配置的 Prompt 作为普通 turn 提交。
- 操作：创建浅层和深层文件、`.tinker.json`，用键盘选择文件和自定义命令。
- 断言：浅层排序、路径文本和展开后的 Prompt 精确；二者都没有绕过正常提交路径。

### PTY-104：`/clear` 安全开始新 session

- 用户视角：`/clear` 后看到空的新对话，但旧工作仍可恢复。
- 操作：完成一轮，记录 session ID，执行 `/clear`，再打开 `/resume` 返回旧 session。
- 断言：新 Header 使用新 ID 且 Timeline 为空；旧 session 仍完整，未被删除或覆盖。

### PTY-105：`/fork` 克隆后独立分叉

- 用户视角：克隆当前工作后，可以在 source 和 clone 分别继续，内容不会串线。
- 操作：source 建立含工具结果的历史，执行 `/fork`；clone 追加 `CLONE_ONLY`，恢复 source
  追加 `SOURCE_ONLY`，再恢复 clone。
- 断言：共同历史相同；source 只有 `SOURCE_ONLY`，clone 只有 `CLONE_ONLY`；两边 SQLite
  都能独立验证。

### PTY-106：`/model` 切换 profile

- 用户视角：空 session 可以用 picker 或完整命令切换模型，旧 session 被保留；已有 turn
  后不能偷偷切换当前对话的模型。
- 操作：配置两个 fake profiles，覆盖 picker 和 `/model <profile>`；完成一轮后再次尝试。
- 断言：切换后 model、profile、session ID 和默认 profile 正确；旧 session 可恢复；禁止
  路径给出明确 notice。

### PTY-107：`/view` 全屏查看并返回

- 用户视角：打开长 UTF-8 文件后可垂直、水平和翻页浏览，Esc 返回时原对话没有丢失。
- 操作：创建长行和多行文件，执行 `/view`，发送方向键、PageDown、End、Home，最后 Esc。
- 断言：当前 screen 只显示 viewer；行号、位置状态和水平列变化正确；关闭后恢复原 Header、
  Timeline 和 Prompt。

### PTY-108：`/copy` 复制 canonical Markdown

- 用户视角：复制的是完整原始 Markdown，不是 TUI 截断文本；恢复 session 后也一样。
- 操作：生成带 code block 和长文本的 final response，执行 `/copy`；退出恢复后再次复制。
- 断言：默认 suite 的 file sink 与 canonical assistant message 字节一致；macOS live
  clipboard 变体再验证系统剪贴板，并在 `finally` 恢复原值。

### PTY-109：`/compact` 与 `/compact retire`

- 用户视角：长 session 压缩后仍能继续使用，被移出 active request 的历史仍能找回。
- 操作：`pty-context-heavy` 产生真实大 observation；分别执行 compact 和 retire，再提交
  Recall 驱动的下一轮。
- 断言：notice 和 `/status` 反映 revision/token 变化；下一轮 completed；Recall 返回原始
  marker；canonical history 未删除。

### PTY-110：图片附件与恢复

- 用户视角：图片 profile 下通过 `@` 选择图片后能看到附件、成功提交，并从 Prompt 历史
  或 resumed session 恢复。
- 操作：配置离线 image fake profile，选择固定 PNG，提交，浏览 Prompt 历史并重启恢复。
- 断言：Timeline 显示图片 label/original name；canonical attachment 和 asset 正确；fake
  model 收到 materialized image；恢复不会创建重复 asset。

### PTY-111：`/status`、`/skills`、`/mcp` 是本地检查

- 用户视角：这些面板显示当前 runtime 的真实状态，但不会消耗一次模型请求或污染对话。
- 操作：配置 Skill 和 MCP，依次打开三个面板，再提交普通 Prompt。
- 断言：面板内容来自当前 binding；fake model request count 在打开面板时不变；session turn
  和 Prompt 历史没有新增 local command。

### PTY-112：Skill 与 MCP 实际调用

- 用户视角：面板里列出的扩展不只是展示，agent 确实可以激活 Skill、调用 MCP 工具并
  使用结果。
- 操作：`pty-skill-activate` 调用测试 Skill；`pty-mcp-call` 调用真实 stdio fixture 的
  `mcp__fixture__echo`。Skill 变体再退出并恢复一次。
- 断言：Skill 进入 active state 且 resume 后仍绑定；MCP fixture 收到精确参数一次，
  Timeline 显示结果，最终回答完成。

## 10. P2：边界、终端兼容与显式 live smoke

### PTY-201：session 管理保护

- 用户视角：可以用完整 UUID 直接恢复和删除旧 session，但当前、active 或 unavailable
  session 不会因误操作被破坏。
- 操作：覆盖 `/resume <full-id>`、`/session delete <id> --confirm`、picker disabled rows 和
  current-session delete。
- 断言：允许的操作真实生效；拒绝路径保留当前 session 和数据，并给出明确理由。

### PTY-202：resize、宽字符和鼠标

- 用户视角：终端运行中变窄再变宽，输入中文/emoji、查看 Markdown 表格或滚动 viewer
  时，不应错位、崩溃或丢失选择。
- 操作：`120 x 30 -> 60 x 16 -> 140 x 40` resize，输入宽字符，打开长文件并发送 SGR
  mouse wheel。
- 断言：每次 resize 后 Header/Prompt/picker 仍在 viewport 内；宽字符不破坏 cursor；鼠标
  只改变 viewer scroll；退出仍正常。

### PTY-203：图片 admission maintenance

- 用户视角：图片导致预算或 aggregate limit 时，原草稿不会消失或重复提交，用户可以选择
  compact、retire、new session 或 Esc 返回编辑。
- 操作：用小预算 profile 触发 maintenance offer，分别覆盖至少 Esc 和一个维护动作。
- 断言：选择前没有 provider request；草稿和附件保留；维护完成后也不会自动重复提交。

### PTY-204：真实 provider PTY smoke

- 用户视角：真实安装配置最终能连接已资格确认的 provider、完成一轮并正常退出。
- 运行方式：凭证控制、手动或专用 CI lane；不进入默认 `bun run check`。
- 断言：真实 provider 返回 final answer，usage/context 状态更新，`/quit` 正常清理。
- 约束：失败报告必须区分产品回归、provider 不可用、凭证错误和网络问题。

## 11. 分阶段实施顺序

### 阶段 A：Harness 基础

状态：已完成（2026-07-23）。

1. 抽出 `PtyTuiHarness` 和环境隔离；
2. 扩展 `pty-host.py` resize control；
3. 接入 headless VT screen；
4. 迁移 PTY-001，证明旧回归仍可捕获；
5. 为 harness 自身增加小型测试：screen 当前态、按键编码、resize ack 和 timeout 诊断。

阶段 A 完成定义：PTY-001 通过；临时删除 `process.exit(0)` 时会稳定变红；恢复后稳定变绿。

### 阶段 B：P0 核心旅程

状态：已完成（2026-07-24）。

按 PTY-002 到 PTY-008 顺序落地。先扩展 named fake modes，再写对应 PTY case；每次只
增加满足当前 case 的最小 fake 行为，不先实现完整场景框架。

阶段 B 完成定义：全部 P0 在 macOS、Linux 默认 CI 中运行，无 skip、无 retry，且进入
`bun run check`。

### 阶段 C：session、输入与本地命令

状态：已完成（2026-07-24）。

实现 PTY-101 到 PTY-109。`/clear`、`/fork`、`/resume` 的 fixture 必须由真实前序进程
创建；`/copy` 按平台能力单独串行。

### 阶段 D：图片、Skills、MCP 与终端边界

状态：P1 部分 PTY-110 至 PTY-112 已完成（2026-07-24）；P2 部分 PTY-201 至
PTY-203 待实施。

实现 PTY-110 到 PTY-203。图片 fake adapter、VT 宽字符和 dynamic resize 都先有针对性
harness 测试，再进入完整 TUI case。

### 阶段 E：provider-backed smoke

PTY-204 只在 provider 资格矩阵和凭证 lane 明确后加入。它与确定性 PTY suite 分开
报告，不能用 live smoke 替代 P0/P1。

## 12. Suite 组织与执行策略

- P0/P1 默认离线并进入 `bun run check`。
- 每个测试使用独立 home/workspace，因此普通 PTY case 可以安全并行；共享 clipboard、
  固定端口或全局资源的 case 必须串行。
- 本地 MCP fixture 使用 stdio，不占固定 TCP 端口。
- 默认 PTY suite 的 CI 目标时长为 90 秒以内；超过后先减少重复启动和无价值等待，不通过
  skip 核心 case 解决。
- 单个文件中的用户旅程保持独立，前一个 case 失败不能阻止后一个 case 清理自己的进程。
- CI 同时保留 macOS、Linux lane。任一平台 P0 失败都视为产品回归。

建议验证命令：

```bash
bun test src/__tests__/cli-pty.test.ts
bun test src/__tests__/cli-pty-session.test.ts
bun test src/__tests__/cli-pty-input.test.ts
bun test src/__tests__/cli-pty-extensions.test.ts
bun test src/__tests__/cli-pty-terminal.test.ts
TINKER_TEST_LIVE_CLIPBOARD=1 bun test src/__tests__/cli-pty-session.test.ts \
  -t "live macOS system clipboard"
bun run check
```

系统剪贴板命令只在有桌面 session 的 macOS 上显式执行；默认离线门禁不注册该变体，
因此不会产生 skip，也不会读写开发者剪贴板。

## 13. 完成标准

只有以下条件全部满足，真实 PTY 测试阶段才算完成：

1. Harness 从真实 `bin/tinker.js` 启动，并能发送语义化按键和 resize；
2. 当前 screen 与 transcript 分离，最终状态不再依赖累计输出 `includes()`；
3. PTY-001 至 PTY-008 全部进入默认门禁；
4. P1 的 session、输入、context、图片、Skills 和 MCP 用户旅程全部有 durable assertion；
5. `/quit`、取消、正常 resume 和 interrupted resume 都验证完整进程生命周期；
6. 测试不读取真实用户配置，不访问公网，不遗留后台进程或临时 session；
7. 超时报告包含当前 screen、transcript tail、host stderr、exit state 和临时路径；
8. macOS、Linux 的确定性 suite 均通过；
9. `bun run check` 通过；
10. 真实 provider smoke 若启用，使用独立资格 lane 并单独报告。

完成后的测试体系应能回答一个直接的问题：用户从真实终端启动 Tinker，连续输入、取消、
调用工具、切换或恢复 session，最后退出时，整条产品链路是否真的可用。
