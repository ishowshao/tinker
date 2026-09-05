# Remote access acceptance record

Local development on 2026-09-05 (Asia/Singapore). No public relay deployment,
public DNS/certificate rollout or external publication was performed. Original
staged Xcode project files and the existing unrelated TUI process were preserved.

## Automated and native checks

| Check | Observed result |
| --- | --- |
| `bun run check:fast` | Passed: 1192 tests, 0 failures, 7116 assertions, 132 files; 28.31 seconds test time |
| `bun run check` | Passed: 1235 tests, 0 failures, 7560 assertions, 138 files; type/format/lint/docs and benchmark smoke all passed; tests 96.42 seconds |
| Source line limit | Every file under `src/` remains at or below 2000 lines |
| iOS Simulator build-for-testing | Passed, original Tinker scheme, Xcode 26.6 / iOS Simulator 26.5 |
| Native simulator test run | 8 passed, 0 failed, 0 skipped, including both real relay UI journeys |
| iPhone Release build | Passed with existing project signing configuration |
| iPhone Release install and launch | devicectl reported successful install and launch on paired iPhone 17 Pro Max |
| Physical-device UI test bootstrap | Not passed: runner exited 74 before connecting to XCTest; see limitation below |

The new service tests cover runtime independence from subscriptions/transport,
canonical/provisional separation, queued prompts, explicit target cancellation,
duplicate/conflicting operations, stale question/confirmation answers, canonical
and service locking, restart receipt reconciliation, gap/duplicate/epoch handling,
throwing subscribers, authentication, schema validation and real HTTPS/WSS loss.
CLI tests prove remote commands bypass local model/TUI bootstrap and the default
command does not load remote runners. Existing full-gate PTY tests remain part of
the completion gate, including input/shortcuts, tools, confirmation, cancellation,
resume, stream rendering and process cleanup.

A real HTTPS/WSS test exposed a Bun 1.3.14 shutdown race: terminating an already
closing TLS WebSocket can leave `server.stop(true)`'s completion promise pending.
The listener/connections close synchronously, and transport shutdown now bounds
that wait before runtime cleanup. A minimal local reproduction and the integrated
regression both established the boundary; it does not couple a network close to
turn cancellation.

## Real-model relay acceptance

All five scenarios passed through **HTTPS → local frps → verified mTLS frpc →
loopback Tinker service**, using the currently configured `gpt-6-astra` Responses
profile. Fault injection stopped only relay/tunnel processes; the Mac's model
provider connection was left available. The canonical history and operation
receipts were inspected, not just request acknowledgements.

Artifact: `.tinker/remote-local/live-acceptance.json`, completed
`2026-09-05T15:39:08.144Z`. Session:
`01a07238-449a-74ea-b329-6e2b6768dd19`.

| Scenario | Evidence |
| --- | --- |
| Tunnel stopped during real Bash sleep | Task continued and committed `REMOTE_TUNNEL_433a62e6`; same turn recovered |
| Relay stopped during real Bash sleep | Task continued and committed `REMOTE_RELAY_1fa9bd48`; same turn recovered |
| AskUser across tunnel outage | Same interaction remained pending; one answer UUID retried without duplicate effect |
| Bash confirmation across outage | Same confirmation remained pending and was explicitly resolved after reconnect |
| Accepted receipt discarded | Retry UUID `adf20a21-6a15-4eec-b05c-4f7ecd841b05` returned same work; canonical user-message count was exactly 1 |

The confirmation fixture defines a shell function named `reboot` that only prints
`REMOTE_GUARD_FIXTURE`, then invokes that function. The script checks the entire
pending command for an exact match before allowing it. No machine reboot or
system-setting change is involved. An earlier disposable-directory deletion did
not trigger the existing guard and was not counted as confirmation acceptance.

## Native UIKit workflows

Authoritative simulator result: `.tinker/remote-ios-results-fixed`.
`xcresulttool` reports **8 passed / 0 failed / 0 skipped**. The two real-model UI
journeys passed in 46.642 and 80.615 seconds respectively. They use normal pairing
fields, workspace/session navigation, task entry and native buttons, with the
private pairing JSON supplied only to the test runner.

* Pairing rejects an HTTP URL. Unit tests cover HTTPS/pin validation, stable outbox
  UUIDs, explicit null dismissal, cursor/gap handling and canonical-history merges.
* A foreground real Bash tool is visible; after Home/background, the app reconnects
  and shows the completed result.
* The app is terminated after acceptance, then relaunched; the saved session and
  complete result return without a second prompt submission.
* A real AskUser is preserved across background/foreground; the answer completes
  the same task. The next real task is explicitly stopped and shows cancelled.

Acceptance markers: `IOS_BACKGROUND_187550CB` and `IOS_RELAUNCH_2AF24CF0`.
Screenshots exported to `.tinker/remote-ios-visuals` were visually inspected for
native layout, tool progress and recovered conversation. Text/tool details remain
selectable; rich Markdown and image attachment rendering are outside this first
client's implemented UI.

An earlier automation attempt appended the relay port to the existing URL because
the test's deletion depended on the cursor position. The field now exposes its
normal clear button, automation asserts the full replacement value, and pairing
also rejects an out-of-range port. The corrected run above is the passing record;
interrupted/failed earlier result bundles are not counted.

## TUI compatibility

`scripts/remote-tui-smoke.ts` launched actual PTYs and isolated local TUI runtimes
with a deterministic model fixture, under these independently established states:

| State | Startup to prompt | Unicode multiline turn | Exit |
| --- | --- | --- | --- |
| Daemon absent | 588 ms | 157 ms, passed | `/quit`, code 0 |
| Daemon running | 573 ms | 158 ms, passed | `/quit`, code 0 |
| Relay disconnected, daemon running | 524 ms | 130 ms, passed | `/quit`, code 0 |

Artifact: `.tinker/remote-local/tui-acceptance.json`,
`2026-09-05T15:53:53.793Z`. These are single-run smoke timings, not a statistical
performance benchmark. They establish no network dependency on local TUI startup
or work. The existing full-suite PTY regression provides the broader behavior gate.

A separate default TUI run used the real `gpt-6-astra` profile with the existing
Chrome MCP configuration. Session `01a07246-eb07-7528-9499-bf54a2ddce1a` completed
with `TUI_REAL_MODEL_REMOTE_REGRESSION_OK`, displayed the canonical assistant
response and exited normally through `/quit`. No file edits/tools were requested.
The explicit `tinker connect` mode was also exercised through the relay with a
new service session `01a07249-905f-7179-a16a-51d056b768bf`: provisional
`REMOTE_TUI_NATIVE_OK` became a canonical assistant
reply, status changed to completed, and `/quit` detached successfully.

## Physical-device and public limitations

The paired iPhone 17 Pro Max was reachable over CoreDevice/local network. Release
build, install and a direct devicectl launch succeeded. This does **not** prove its
foreground/background/lock behavior. The first physical XCTest attempt and a
second attempt explicitly selecting arm64 both failed before any test began:

> Early unexpected exit, operation never finished bootstrapping

The detailed log reports `IDE disconnection`, a refused XCTest driver channel and
runner exit **74**. The app-side acceptance trace was absent because the real UI
journey never launched. Evidence bundles are `.tinker/remote-ios-device-results`
and `.tinker/remote-ios-device-results-arm64`; logs are
`/tmp/tinker-remote-ios-device-tests.log` and
`/tmp/tinker-remote-ios-device-tests-arm64.log`. Device support lookup also emitted
warnings; a specific underlying cause was not established. The user's help to
unlock/keep the device available was requested, but no manual lock/unlock result
was received during this run.

Consequently **physical iPhone foreground progress, background completion,
lock/unlock, termination recovery and P_TRACED=false evidence remain unverified**.
Simulator results above are not substituted for them. The Release build is left
installed for manual acceptance. Re-establish a working device/XCTest connection
or run the manual flow outside Xcode: pair through 18443, submit a uniquely marked
Bash sleep, confirm acceptance/progress, Home or lock, let it finish, unlock and
reopen the same session. Compare its request/turn IDs and canonical completion
timestamps before/after; repeat after force-quitting the app. Do not treat a
successful install or model-only test as this evidence.

Also unverified: public cellular access, Wi-Fi/cellular switching, formal-domain
PKI and renewal, public-firewall behavior, long-duration relay outages, Mac
sleep/power loss and production supervisor recovery. Process recovery has
canonical/receipt automated coverage; this work does not promise arbitrary tool
resumption after a crash. Global Memory remains the existing local-TUI feature;
remote sessions do reuse Recall, skills, tools, providers and canonical persistence.
No production startup service was installed. See the
[runbook](remote-access.md#public-deployment-configuration) for deployment and the
public real-device acceptance sequence.
