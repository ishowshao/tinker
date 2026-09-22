# Remote Tinker: local operation and deployment

The native UIKit client lives in the original `client/Tinker/Tinker.xcodeproj`.
The Mac owns execution. A phone or terminal connection is a detachable view of
that execution. See [design and ownership](remote-access-design.md) for the
implementation decisions and phased plan.

## Local start

Prerequisites: macOS, the repository's Bun dependencies (`bun install`), OpenSSL,
Xcode with the existing project's iOS SDK, and a working local model profile.
The setup downloads frp **0.71.0** from its official release and checks its pinned
SHA-256 digest. It generates private development credentials; do not commit or
share the `.tinker/remote-local` directory.

```sh
# Use the Mac's current Wi-Fi address explicitly for an actual iPhone.
bun scripts/remote-local.ts setup --host 192.168.1.20 --workspace /absolute/workspace --profile your-profile
bun scripts/remote-local.ts up
bun scripts/remote-local.ts status

# Optional service-owned terminal UI.
bun run tinker connect --config .tinker/remote-local/client.json

# The existing local UI remains independent.
bun run tinker

# Stop only the tunnel, for example; the daemon continues working.
bun scripts/remote-local.ts down tunnel
bun scripts/remote-local.ts up tunnel

# Explicitly shut down this local stack, including hosted runtimes.
bun scripts/remote-local.ts down
```

`setup` refuses to overwrite an existing pairing. Use `--directory /private/path`
for a separate environment. Pass that directory to every launcher/smoke command.
Model configuration is loaded on the Mac using the existing environment/model
profile rules. Neither pairing file contains model credentials. A workspace can
select a profile in `service.json`; newly created sessions use it, while resumed
sessions retain their existing runtime/profile selection rules.

The three independent processes and ports are:

| Component | Local binding | Responsibility |
| --- | --- | --- |
| Tinker service | HTTPS `127.0.0.1:19443` | Runtime, tools, canonical SQLite |
| frps | control `127.0.0.1:17000`, relay `0.0.0.0:18443` | Opaque TCP forwarding |
| frpc | outbound to `127.0.0.1:17000` | Verified mTLS reverse tunnel to service |

Both `client.json` and `pairing.json` use relay port **18443**. Connecting to
19443 bypasses the tunnel and does not qualify as full-chain acceptance.
`service.json`, `frps.toml`, `frpc.toml`, `certs/`, logs and PID records are generated
under the selected private directory. The launcher checks process identity before
sending SIGTERM and does not manage unrelated Tinker processes. `up` is a local
process launcher, not a login/startup installation; it does not configure launchd.
Use `status` and the component logs to diagnose a startup failure.

## Default local service entry

On macOS/Linux, `tinker` (or `bun run tinker` in this checkout) now discovers or
starts the shared local service, registers the current workspace and opens the
existing full TUI. `--profile <name>` selects the new session's model profile;
`TINKER_WORKSPACE` still overrides the current directory. Each launch starts a new
session; `/resume` connects existing sessions, including safely adopting an old
independent session once its local process has exited. Exiting the TUI detaches
without cancelling work accepted by the service.

First launch creates `<home>/.tinker/service/`, with `service.json`, `client.json`,
`server.crt` and `server.key`; `<home>` follows `TINKER_HOME`. OpenSSL is needed for
this one-time certificate generation. The complete bundle is published atomically
so concurrent first launches share one identity. The directory is private (0700)
and configuration/credential files are 0600. The self-signed local certificate is
trusted only through that client configuration, not installed into system trust.
It expires after 365 days; certificate renewal is not automatic. System supervision
can be installed explicitly as described below.

Auto-created service configuration binds to loopback with a dynamically selected
port and starts with an empty workspace list. Local registration fills the durable
registry. After startup/restart, the auto-created local client URL is updated to
the actual listening address without rotating its credentials. A pre-existing
service config is respected and requires a matching sibling `client.json`;
missing, invalid or revoked credentials fail visibly rather than being replaced.
Existing project `.data` files are not auto-selected or overwritten: use the
explicit `connect --config ... --tui --service-config ...` command to keep using
that separate service and its paired devices.

All directories using the same home share this default service. The service keeps
the environment of its initial launcher; model/provider environment changes in a
later terminal are not applied to an already running daemon. Restart the service
to change its environment. Workspace instructions, Skills and configuration files
continue to resolve in the selected workspace. Inspect the default instance with
`tinker serve --status`; the JSON includes its PID and the state/log paths.

Connection/startup failures exit with an error, without silently starting a second
independent runtime. `tinker --local [--profile <name>]` explicitly retains the
independent TUI, including on Windows where local background startup is not yet
supported. `tinker run` remains the independent one-shot path. Help/version and
non-interactive default invocation do not initialize configuration or start a
service. The TUI layout and interaction controls remain unchanged.

## Local discovery and background startup

For an already configured service on macOS/Linux:

```sh
bun run tinker serve --config .data/service.json --background
bun run tinker serve --config .data/service.json --status
bun run tinker connect --config .data/client.json --tui --workspace tinker
```

`--background` returns JSON only after the service is ready, or reuses a ready
service with matching configuration. Multiple concurrent launchers converge on
the same instance. The detached process survives launcher and terminal exit;
install the optional LaunchAgent below for login startup and crash restart. Without either
flag, `serve` continues running in the foreground. `--status` does not start or
repair anything; it returns exit 0 for online, exit 1 when not ready or on error.
The two flags are mutually exclusive. Plain `bun run tinker` now opens the full
TUI through the shared local service; `bun run tinker --local` runs independently.

| Setting or artifact | Location / rule |
| --- | --- |
| Service config | Explicit `--config`, otherwise `<home>/.tinker/service/service.json`; `<home>` is `TINKER_HOME` or the OS home |
| State directory | Config `stateDirectory`, otherwise `./state` beside the configuration file; canonicalized before locking |
| HTTPS address | Loopback `hostname` and `port` from config; defaults `127.0.0.1:9443`; explicit port `0` requests an available port |
| Instance metadata | `<stateDirectory>/service-instance.json`, includes actual HTTPS URL, PID, boot identity and configuration fingerprint; no pairing credentials |
| Startup diagnostics | `<stateDirectory>/service.log`, private append-only stdout/stderr for the detached process |
| Ownership | `<stateDirectory>/startup/active.lock` serializes launchers; `<stateDirectory>/active.lock` excludes competing runtime owners |
| Local control | Private per-user Unix socket under `/tmp/tinker-service-<uid>/`, keyed by canonical state directory; instance discovery and local workspace registration |

The state directory is private (0700); metadata, socket and logs are private
(0600). Discovery requires a live socket response, not just a PID or metadata
file. It does not expose an unauthenticated HTTPS endpoint or change TLS/device
authentication for clients. Relative configuration paths resolve beside the
configuration file, independently of the terminal's working directory. The
explicit `serve` command requires prepared configuration; automatic local setup
is performed by the default TUI entry described above.

Changed service configuration, TLS material or `TINKER_HOME` is not silently
applied to a running service. Stop the old process explicitly before restarting
with the new configuration. A pre-discovery version of the foreground service
also needs an explicit restart once. A live but unresponsive owner is left alone;
startup fails after a bounded wait and identifies the diagnostic paths. Stale
leases from dead processes can be reclaimed. Occupied ports and early child
exits fail visibly without selecting another service. Different explicit state
directories are separate service instances; use the shared default for normal
single-service operation.

Port `0` is useful for isolated services, but existing client pairing files still
need the actual URL returned by startup and can change after restart. Keep a
fixed port for manually paired clients. The default entry updates its auto-created
local client URL after each startup. The optional system supervisor uses the same
state-directory ownership and discovery mechanism.

## Resident operation

The service retains lightweight canonical session leases after startup, and opens
runtimes only when a client or operation needs them. Startup repairs interrupted
canonical state without loading providers, Skills or MCP runtimes for every old
session. Idle unloading closes SQLite readers, runtime/tool resources and MCP
connections, and discards projection/event buffers while retaining the canonical
lease and history. A local process cannot take over an unloaded service session.
A resumed client reconstructs its view from canonical state. Model profile and
session reasoning/YOLO overrides survive unloading.

A runtime is reclaimable only when it has no connected clients, HTTP request,
turn, queued prompt, interaction, maintenance operation or running/stopping
background task. Clients disconnecting never cancel accepted work. On pressure,
the oldest reclaimable runtime is unloaded; if every slot is busy or connected,
the request fails with `RUNTIME_LIMIT` instead of evicting active work. Historical
session count is independent of this runtime cap.

Optional `resident` configuration in `service.json` (shown with defaults):

```json
{
  "resident": {
    "maxLoadedSessions": 16,
    "maxConcurrentTurns": 4,
    "maxPendingTurns": 32,
    "idleTimeoutMs": 300000,
    "shutdownGraceMs": 30000
  }
}
```

The pending-turn limit includes running and queued work across the service;
per-session queues retain their existing eight-waiter cap. FIFO execution slots
limit concurrent turns, and queued cancellation does not run the model. New work
beyond capacity is rejected before acceptance. Control requests retain admission
headroom so clients can answer interactions or stop tasks under load. The three
count limits accept integers 1–4096; durations accept 1–86400000 milliseconds.
Concurrent turns cannot exceed loaded runtimes, and pending turns cannot be less
than concurrent turns. Configuration changes require a restart. `serve --status`
reports version, phase, loaded/managed session counts, execution/queue counts and
policy; the authenticated `GET /v1/service` also exposes resource status.

### macOS login startup and crash restart

```sh
bun run tinker serve --install
bun run tinker serve --status
bun run tinker serve --stop
bun run tinker serve --background
bun run tinker serve --uninstall
```

These commands also accept `--config <service.json>`. Installation drains any
existing detached service, writes a per-user LaunchAgent in the OS user's
`~/Library/LaunchAgents/` and starts it in the GUI login domain. `TINKER_HOME`
continues to select service/session data, not the LaunchAgents directory.
Repeated installation reuses an existing installation. The job runs `serve` in
the foreground and conditionally restarts it through a private enabled marker,
with a 10-second crash restart throttle. Plain `tinker` and `serve --background`
reuse/reactivate the supervisor instead of starting a competing detached owner.
The mechanism follows Apple's [LaunchAgent lifecycle](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
and [conditional KeepAlive contract](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5).

Installation captures `TINKER_*`, Exa credentials, PATH/HOME, locale/timezone and
proxy/TLS environment into private `supervisor-env.json` (0600) beside the service
state. The plist contains that file path rather than provider credentials. Put any
additional MCP/tool environment keys in that file before restarting. Both the
runtime configuration and child tools receive the restored environment. It is a
per-user login agent: logout stops it, and it does not keep the machine awake or
run before login. macOS needs a GUI login domain; other platforms retain explicit
foreground/background operation and do not install a supervisor in this batch.

`--stop` disables automatic restart and waits for the service to release its
lease. `--background` or the next default TUI launch enables it again.
`--uninstall` stops and removes only this job, its enabled marker and saved
supervisor environment; it retains service/client configuration and all history.
CLI registration/removal is explicit; starting the default TUI never installs a
login agent. Inspect the private `service.log` for startup/shutdown diagnostics.
Log rotation and certificate renewal remain manual operational tasks.

### Shutdown and upgrade

```sh
bun run tinker serve --restart
bun run tinker serve --stop --force
# For a global npm installation:
tinker serve --stop
tinker update
tinker serve --background
```

`--stop`, `--restart`, installation and removal use the private local control
socket. The service first stops accepting new work, while allowing answers and
explicit stop requests for existing tasks. It waits up to `shutdownGraceMs` for
turns, maintenance and background tasks to finish. Without `--force`, timeout
cancels shutdown, restores admission and reports `SERVICE_BUSY`. With `--force`,
remaining work is interrupted after the grace period. Receipts preserve that
interruption across restarts, including when a runtime cooperatively cancels its
canonical turn; uncertain work is never replayed. Signals also drain up to the
grace period, then dispose resources; a hard shutdown deadline prevents a stuck
runtime from indefinitely keeping the process alive. A hard exit leaves canonical
recovery to the next service startup.

`tinker update` checks all private live discovery sockets for services using the
same package installation before npm replaces files. An enabled supervisor also
blocks upgrade while its process is in crash backoff. Stop it explicitly first;
updates do not force cancellation or silently switch a running service to a new
version. A different published application version is rejected by default startup
with instructions to restart. Source-checkout changes require `serve --restart`
as well, even when `package.json` has the same version. Failed upgrades leave the
service stopped for inspection or rollback; session data stays outside the package.

A service started before the resident control endpoint existed needs a one-time
explicit process stop. `serve --status` can report its live PID even if normalized
configuration differs. The new control command reports the verified PID when it
cannot drain an older service; it never sends a signal based on a stale PID file.

## Current directory and existing sessions

A local terminal can start/reuse the service, register its current directory and
open the full TUI with one command:

```sh
bun run tinker connect --config .data/client.json --tui --service-config .data/service.json
# Resume an existing local session after exiting its local TUI:
bun run tinker connect --config .data/client.json --tui --service-config .data/service.json --session SESSION_UUID
# Subsequent connections can resolve an already registered directory:
bun run tinker connect --config .data/client.json --tui
```

Relative config paths resolve from the terminal's current directory. The service
and client configurations must refer to the same running instance; the terminal
checks the authenticated HTTPS instance identity before registering anything.
`--workspace <id>` still explicitly selects a workspace and bypasses directory
registration. For a terminal on another machine, use this explicit ID.

Directory matching uses canonical paths, including symlink resolution, and picks
the nearest registered ancestor. A subdirectory uses that workspace's root for
execution. If no ancestor exists, `--service-config` authorizes registration of
the current directory through the private local socket. Remote HTTPS clients can
resolve registered roots but cannot register arbitrary host directories.
Concurrent registrations of the same canonical path reuse one stable ID.

Registrations live in the service's SQLite workspace registry, survive restarts,
and become available without restarting the service. `service.json` is not
rewritten. Its configured workspaces and the registry are combined at startup;
conflicting IDs or paths fail visibly. Preserve a registered ID and canonical
path when adding its configuration, for example to select a model profile.
Registered roots become accessible to the service's paired devices under the
same personal-agent trust boundary as configured roots.

Old sessions are opened in place from canonical SQLite history under the same
workspace root and `TINKER_HOME`; this does not move history between roots or
homes. Explicit `--session` also supports an empty resumable session. The service
must acquire the canonical session lease before recording ownership. A local
process still holding that lease blocks adoption, including a race after the
catalog lookup. Normal exit releases the lease; a dead process's stale lease can
be reclaimed. Multiple clients adopting the same session share one runtime.
Failed adoption leaves no managed ownership, and retrying a new request after
release can succeed. Previous tasks are never replayed automatically. Exiting
the connected TUI detaches the client and leaves the service owning the session.

## iPhone pairing and operation

Build the existing `Tinker` scheme. On the same Wi-Fi, allow Local Network access.
In the app choose **连接设置 → 导入配对文件**, select the generated `pairing.json`,
review the entry and save it. Alternatively enter its HTTPS URL, device token and
certificate SHA-256 fingerprint manually. Transfer this private file directly to
your device, not through a public URL. Import is explicit; merely opening a file
does not silently replace trust settings.

The app stores pairing credentials in Keychain and a protected persistent outbox,
drafts, selected session and recent view in its application container. Development
trust is scoped to the paired certificate, with hostname and validity checks;
no global trust or ATS bypass is installed. A certificate change requires reviewing
and replacing the pin. Generated app/tunnel certificates expire after 90 days.

Select a workspace, create or enter a service session, and send a task. Locally
owned sessions have an explicit adoption action; the current local TUI must first
release its canonical session lease. The task state and connection state are shown
separately. During disconnect, accepted work continues; an uncertain submission
stays in the outbox with the same request UUID. Foreground activation and relaunch
reconnect and reconcile the saved view automatically. Older history is available
through **加载更早的历史**. Text is selectable; this version displays plain text and
tool details rather than rich Markdown or attachment previews.

Questions and command confirmations remain pending on the Mac. **稍后处理** only
closes the sheet. Choosing an answer, explicitly skipping a question, allowing or
denying a command sends an authenticated operation with the interaction ID.
**停止** targets the currently active request. Follow-ups submitted during a turn
are accepted for the next turn (up to eight queued requests per session).

The explicit terminal client supports workspace/session selection, `/new`,
`/history`, `/answer N`, `/dismiss`, `/allow`, `/deny`, `/stop`, `/workspaces` and
`/quit`. Ctrl-C and `/quit` detach this client. Its pairing-adjacent state file
retains uncertain requests for retry. Default `tinker` continues to use the
existing local TUI, commands, shortcuts and cancellation semantics.

## Modules and protocol v1

| Module | Boundary |
| --- | --- |
| `src/agent/runtime-hosted-session.ts` | Runtime lifetime, prompt queue, explicit cancellation, pending interactions and runtime-to-view adapter |
| `src/remote/service.ts`, `service-store.ts` | Managed-session ownership, durable operation receipts and startup reconciliation |
| `src/session/remote-history-reader.ts` | Read-only canonical SQLite history, including committed open-tail messages |
| `src/remote/sync-hub.ts`, `http-server.ts` | Epoch/sequence, snapshot/replay, authentication, HTTPS/WSS and bounded delivery |
| `src/cli/serve-*` | Existing model/config/skills/MCP/runtime composition |
| `src/remote/client.ts`, `src/tui/remote-app.tsx` | Explicit remote terminal adapter |
| UIKit `RemoteAPI`, `RemoteAppStore`, view controllers | TLS, persistent outbox, synchronization and native UI |

All routes require `Authorization: Bearer <device-token>`. Browser Origin requests
are rejected. Devices authorized in one service configuration can access all of
that service's allowlisted workspaces; this is a personal-agent trust domain, not
multi-tenant isolation. The allowlist selects the starting workspace; tools retain
the same filesystem/process privileges and guard policy as local Tinker.

| Method/path | Result |
| --- | --- |
| `GET /v1/service` | Authenticated service instance identity |
| `GET /v1/workspaces` | Human-readable workspace catalog |
| `GET /v1/workspaces/resolve?directory=...` | Resolve an absolute host directory within registered roots |
| `GET /v1/workspaces/{id}/tui-sessions/{sessionId}` | Exact full-TUI session lookup, including empty sessions |
| `GET /v1/workspaces/{id}/sessions` | Local/service ownership and session catalog |
| `POST /v1/operations` | HTTP 202 durable operation receipt |
| `GET /v1/operations/{requestId}` | Latest receipt |
| `GET /v1/sessions/{id}/snapshot` | Current versioned snapshot |
| `GET /v1/sessions/{id}/history?before={ordinal}&limit=80` | Canonical history page; maximum limit 100 |
| `WSS /v1/sessions/{id}/events?epoch={epoch}&after={sequence}` | Atomic snapshot or retained ordered replay, then events |

An operation is one of these JSON shapes (UUIDs are generated by the client):

```json
{"kind":"create","requestId":"UUID","workspaceId":"workspace"}
{"kind":"adopt","requestId":"UUID","workspaceId":"workspace","sessionId":"SESSION_UUID"}
{"kind":"prompt","requestId":"UUID","sessionId":"SESSION_UUID","prompt":"Task"}
{"kind":"stop","requestId":"UUID","sessionId":"SESSION_UUID","targetRequestId":"PROMPT_UUID"}
{"kind":"answer","requestId":"UUID","sessionId":"SESSION_UUID","interactionId":"INTERACTION_UUID","selectedIndex":0}
{"kind":"confirm","requestId":"UUID","sessionId":"SESSION_UUID","interactionId":"INTERACTION_UUID","decision":"deny"}
```

`selectedIndex: null` explicitly dismisses a question. A retry must preserve the
entire operation and device identity. Reusing a request ID with different data
returns 409. A new request ID expresses a new intent; never generate one merely
because a receipt was lost. Receipt states are `accepted`, `running`,
`waiting_input`, `completed`, `failed`, `cancelled`, and `interrupted`.

Frames carry `version: 1`, `type`, `epoch`, and `sequence`; snapshots carry `view`,
and events carry `change: {activity, messages}`. History rows have stable message
IDs and ordinals. Merge by identity/order; ignore duplicate event sequences. A gap,
new epoch or expired cursor requires a snapshot. There is no await between taking
an initial view/cursor and installing its subscription. The ring retains at most
256 events/8 MiB; slow clients disconnect and resynchronize. WSS accepts no
mutation messages. The provisional `streaming` field is never a canonical
assistant message and is cleared/replaced on commit, retry, terminal state or
process recovery.

Canonical SQLite is authoritative. The separate `remote.sqlite` stores service
ownership and request receipts with a service-directory lease. Each hosted runtime
also holds the existing canonical session lease. After a daemon crash, ambiguous
accepted/running requests become interrupted; completed canonical turns reconcile
their receipt. Startup does **not** replay tools or resubmit queued prompts. A phone
or relay reconnect does **not** restart the daemon or runtime. Daemon shutdown,
Mac sleep/power loss, and model-provider failure are separate lifecycle/failure
conditions. Keep the Mac awake and connected for availability.

Transport shutdown forcibly closes sockets and bounds Bun's close-completion wait
so a TLS WebSocket close race cannot indefinitely defer runtime disposal. This is
covered by a real HTTPS/WSS lifecycle test.

## Repeatable verification

Run relay-fault tests serially; they deliberately stop local relay/tunnel processes.
They do not block the Mac's network path to the model provider.

```sh
bun run check:fast
bun run check
bun scripts/remote-live-smoke.ts
bun scripts/remote-tui-smoke.ts

xcodebuild build-for-testing -project client/Tinker/Tinker.xcodeproj \
  -scheme Tinker -destination 'platform=iOS Simulator,id=SIMULATOR_ID' \
  -derivedDataPath .tinker/remote-ios-build
```

The native tests always run pairing validation and model/sync unit tests. To run
the two real relay UI journeys, put `TINKER_UI_PAIRING_JSON` in each test target's
`EnvironmentVariables` in a private copy of the generated `.xctestrun`. This value
is the content of `pairing.json`, not its filename. Without it those journeys
explicitly skip. One reproducible preparation command after build-for-testing:

```sh
python3 - <<'PY'
import json, os, plistlib
from pathlib import Path
products = Path('.tinker/remote-ios-build/Build/Products')
source = next(products.glob('Tinker_Tinker_*.xctestrun'))
run = plistlib.loads(source.read_bytes())
pairing = Path('.tinker/remote-local/pairing.json').read_text()
for configuration in run['TestConfigurations']:
    for target in configuration['TestTargets']:
        target.setdefault('EnvironmentVariables', {})['TINKER_UI_PAIRING_JSON'] = pairing
output = products / 'Tinker_remote_acceptance.xctestrun'
output.write_bytes(plistlib.dumps(run))
os.chmod(output, 0o600)
PY
xcodebuild test-without-building \
  -xctestrun .tinker/remote-ios-build/Build/Products/Tinker_remote_acceptance.xctestrun \
  -destination 'platform=iOS Simulator,id=SIMULATOR_ID' \
  -parallel-testing-enabled NO -resultBundlePath .tinker/remote-ios-results
```

Use a new result-bundle path for each run. For an actual iPhone, use a separate
build directory, the device destination and development signing. Unlock/trust the
device. Run the app outside Xcode's debugger; the opt-in Debug acceptance trace
(`TINKER_ACCEPTANCE_DIAGNOSTICS=1`) records launch/foreground/background, PID,
request/session ID and the `P_TRACED` debugger flag, without prompts or credentials.

For isolated simulator acceptance without a model provider or public relay, run
`bun src/__tests__/fixtures/ios-acceptance-service.ts <new-temporary-directory>`.
The fixture starts a loopback HTTPS service with a deterministic model, real Bash
and AskUser tools, and an HTTP-created session awaiting a question response.
It writes a private `pairing.json` and certificates into that directory. Use this
pairing file in the `.xctestrun` preparation above. On a dedicated simulator,
install its CA with `xcrun simctl keychain SIMULATOR_ID add-root-cert
<new-temporary-directory>/certificates/ca.crt`. Keep simulator ad-hoc signing
enabled so the app can use Keychain; do not build the network tests with
`CODE_SIGNING_ALLOWED=NO`.

This also enables the protocol-to-UIKit handoff test: open a pending question,
background and foreground the app, answer through another HTTPS client, verify
the open sheet disappears, and relaunch to recover the completed session. The
existing background execution and explicit-stop journeys run against the same
fixture. Stop the fixture after testing and remove the dedicated simulator and
temporary credentials. These direct local transport checks do not validate a
public relay, physical-device lock screen or cellular network switching.
Release builds do not emit this trace. App-side trace plus canonical timestamps
must demonstrate that the accepted turn continued while the actual device was
backgrounded/locked/terminated. A simulator is insufficient evidence for that claim.

## Public deployment configuration

Local acceptance does not deploy anything publicly. Use a **separate** private
production configuration directory, new device/tunnel tokens and separate CA/key
material. Do not copy development private keys to a server.

1. Install the matching verified frps binary on the relay. Configure its control
   listener on a reachable interface and allow only its control port and the one
   application relay TCP port in the firewall. Keep dashboards disabled. Limit
   `allowPorts` to the chosen application port.
2. Give frps a server certificate for its real control hostname. Set
   `transport.tls.force=true`, `certFile`, `keyFile`, and `trustedCaFile` for the
   dedicated tunnel CA. Set the tunnel token. The server needs its own key and the
   CA certificate, never the CA signing key or the Mac's frpc key.
3. On the Mac set frpc `serverAddr`/`serverPort` to that control endpoint,
   `transport.tls.enable=true`, the matching `serverName`, `trustedCaFile`, and its
   own client certificate/key. Keep `loginFailExit=false`. The TCP proxy still
   targets `127.0.0.1:19443`; set `remotePort` to the public application port.
4. Give the Mac Tinker service a valid certificate/full chain for the application
   hostname used by the phone. TLS still terminates on the Mac. For public PKI,
   pair `https://your-domain:port` with no certificate pin; native system trust and
   hostname validation apply. Automate certificate renewal and service reload in
   your deployment process; renewing a pinned leaf requires new pairing.
5. Add one `devices` entry per phone/terminal, each with a distinct randomly
   generated 32-byte base64url token and its lowercase SHA-256 digest. Share only
   that device's token. Remove a device digest and restart the service to revoke it
   (restart explicitly interrupts active work). The generated local configuration
   intentionally shares one development identity between phone and terminal.
6. Run frps under the server's process supervisor and frpc/service under the Mac's
   selected login/system service supervisor. Use absolute executable/config paths,
   private file permissions, logs, restart policy and explicit model environment.
   Production startup installation is not performed by the local launcher. A Mac
   logout, sleep, reboot or crashed service is not repaired by phone reconnect.

Before public use verify real-device cellular access, Wi-Fi↔cellular handover,
formal hostname/chain/expiry rejection, wrong/revoked device credentials, tunnel
mTLS failures, relay restart, prolonged offline completion, device background and
lock outside a debugger, lost-receipt retry, pending questions/confirmations, and
local process-crash recovery without tool replay. Inspect canonical turn/message
counts as well as the phone view. Keep `tinker --local` as an explicit independent execution route.

See [recorded acceptance](remote-access-acceptance.md) for what actually ran and
which device/public scenarios remain unverified.
