# iPhone remote access: design and implementation plan

## Scope and inspected seams

The existing default CLI/TUI remains an independent, local RuntimeSession owner.
The UIKit app in `client/Tinker/Tinker.xcodeproj` and an explicit `tinker connect`
terminal client talk to a new `tinker serve` process. This is local development;
public deployment and publication are separate work.

Inspected contracts: `RuntimeSession.admitTurn` commits admission before returning
an accepted turn; the supplied AbortSignal owns cancellation. RuntimeInteractions
retains AskUser/Bash waits in the runtime. SessionStore takes SessionLease and
recovers interrupted frames without re-running tools. ResumeProjectionReader is
for closed turns and truncates its TUI projection, so remote synchronization needs
its own canonical, read-only history reader that also accepts an open tail.
Presentation sinks are auxiliary: diagnostic logs are not a reliable wire protocol.

## Boundaries

* `src/cli/serve-runner.ts` composes existing configuration, instructions, skills,
  model clients and RuntimeSession for allowlisted canonical workspaces.
* `src/agent/runtime-hosted-session.ts` owns hosted runtime execution and its view adapter.
* `src/remote` owns authentication, durable operation receipts, managed-session
  ownership, the synchronization view, and HTTP/WebSocket transport. No provider
  implementation or network behavior enters the local TUI/agent loop.
* `src/session/remote-history-reader.ts` reads committed messages/turns directly
  from canonical SQLite. It does not mutate history or replay diagnostics.
* UIKit owns navigation, rendering, Keychain credentials, a persistent request
  outbox, and foreground reconnect. The explicit terminal connection mode uses
  the same service API and relinquishes only its subscription when it exits.
* frps relays TCP, frpc connects outward. HTTPS/WSS terminates at Tinker on the
  Mac, so relay traffic is opaque; the reverse tunnel also uses verified mTLS.
  Model credentials never enter client configuration or the relay.

## Lifecycle and ownership

The daemon keeps one promise/runtime per workspace + session ID, holds each
canonical session lease, and also leases its service state directory. Creating
and attaching are explicit operations. Local sessions are listed as local and
may be adopted only after their existing owner releases the lease. A daemon-owned
session is entered by iOS or `tinker connect`; disconnecting neither stops nor
disposes it. Default local `/resume` continues to enforce the existing lease.

Every mutation has a client-generated UUID and a durable SQLite receipt recorded
before side effects. Reusing an ID with different data is rejected. An in-process
retry returns the same receipt; after a crash an ambiguous operation is marked
interrupted, never replayed automatically. The service records the canonical
turn ID as soon as admission exposes it and reconciles terminal state with
canonical history on reopening. A crash between receipt and admission is reported
as interrupted, with no promise that work began. This provides at-most-once
execution on retries, not arbitrary tool resumption after a process crash.

Accepted prompts belong to a bounded per-session queue. A follow-up submitted
during work is visibly accepted for the next turn. Only a targeted stop operation
aborts that request; stale stops cannot cancel a later turn. Questions and Bash
confirmations carry fresh interaction IDs, and replies must match the pending ID.
Network loss has no resolve/reject/cancel semantics. Service shutdown is an
explicit process lifecycle event and closes runtimes under existing recovery rules.

## Synchronization protocol v1

HTTP submits mutations; WebSocket is read-only. All routes require a per-device
Bearer credential; tokens are stored hashed on the Mac and in Keychain on iOS.
Workspaces are selected from a local allowlist, never an arbitrary remote path.

A subscription atomically reads the current view and registers its listener on
the same JS event loop without an await between them. Each daemon boot has a new
epoch. Each session has a monotonically increasing sequence and a bounded ring
of synchronization events. Events contain versioned view changes, not AgentEvent
or diagnostic JSONL. Clients ignore duplicate sequence numbers, reconnect from
their last cursor, and request a full snapshot on a gap, new epoch or expired
cursor. The initial snapshot contains recent canonical history, history paging
cursor, request states, active turn, provisional streaming text, running tools,
and pending interactions. Older canonical history is paged over HTTP.

Provisional text is explicitly separate from canonical assistant messages. It is
replaced/cleared on model retry or committed response; a process crash discards it.
Canonical committed messages and tool results always win on synchronization.
The in-memory view is updated synchronously; outbound notifications are scheduled
separately, bounded, and disconnect slow consumers so they can snapshot again.
Neither serialization failures nor disconnected subscribers can cancel execution.

UI execution states: unsubmitted/outbox, accepted, running, waiting_input,
completed, failed, cancelled, interrupted. Connection state is orthogonal.

## Implementation phases and evidence

1. Add daemon configuration, receipts/ownership storage, canonical history reader,
   hosted runtimes and versioned sync transport. Test lifecycle, locking,
   idempotency, pending interactions, gaps and backpressure.
2. Add public CLI contracts for `serve`/`connect`, optional terminal client,
   generated CLI documentation, and reproducible local frp/mTLS setup/start/stop.
3. Implement the original UIKit project: pairing, workspace/session navigation,
   history, streaming/tool view, persistent submission, responses and stop.
   Build and test the existing app/test targets.
4. Run real model work through the relay/tunnel; inject client, tunnel and relay
   failures independently of model connectivity; verify canonical outcomes and
   request counts. Test iPhone foreground/background/termination without debugger
   where device controls are available. Run real terminal regression with the
   daemon absent, present and unreachable. Run check:fast while iterating and
   the full `bun run check` completion gate.
5. Record actual evidence and remaining device/public-network validation in a
   runbook. No simulator/mock evidence is labelled physical-device acceptance.

## Transport references

frp explicitly requires a trusted CA to authenticate its server (default TLS
alone does not validate identity): [frp TLS documentation](https://gofrp.org/en/docs/features/common/network/network-tls/).
The local setup generates separate app and tunnel certificates and private tokens;
public configuration substitutes domain/certificate/address files without code
changes. Production clients use system PKI; local pairing may explicitly pin the
app certificate without changing global device trust settings.
