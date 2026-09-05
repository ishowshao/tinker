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
| `GET /v1/workspaces` | Human-readable workspace catalog |
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
counts as well as the phone view. Keep a rollback route to default local `tinker`.

See [recorded acceptance](remote-access-acceptance.md) for what actually ran and
which device/public scenarios remain unverified.
