import type { RemoteChange, RemoteCursor, RemoteFrame, RemoteView } from "./protocol";

/** Synchronous cursor allocation; transport delivery is always outside the runtime. */
export class RemoteSyncHub {
  private sequence = 0;
  private readonly ring: { frame: RemoteFrame; bytes: number }[] = [];
  private ringBytes = 0;
  private readonly listeners = new Set<(frame: RemoteFrame) => void>();
  private pending: RemoteFrame[] = [];
  private scheduled = false;
  constructor(
    readonly epoch: string,
    private readonly readView: () => RemoteView,
    private readonly capacity = 256,
  ) {}

  snapshot(): RemoteFrame {
    return {
      version: 1,
      type: "snapshot",
      epoch: this.epoch,
      sequence: this.sequence,
      view: this.readView(),
    };
  }
  publish(change: RemoteChange): void {
    const frame: RemoteFrame = {
      version: 1,
      type: "event",
      epoch: this.epoch,
      sequence: ++this.sequence,
      change,
    };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    this.ring.push({ frame, bytes });
    this.ringBytes += bytes;
    while (this.ring.length > this.capacity || this.ringBytes > 8 * 1024 * 1024)
      this.ringBytes -= this.ring.shift()!.bytes;
    // A single scheduled delivery per tick; no subscriber can hold up append().
    this.pending.push(frame);
    if (this.pending.length > this.capacity) this.pending = [this.snapshot()];
    if (!this.scheduled) {
      this.scheduled = true;
      setTimeout(() => this.deliver(), 0);
    }
  }
  subscribe(
    cursor: RemoteCursor | undefined,
    listener: (frame: RemoteFrame) => void,
  ): () => void {
    // No await between reading the cursor/view and installing the subscription.
    let last = this.sequence;
    const oldest = this.ring[0]?.frame.sequence ?? this.sequence + 1;
    const replay =
      cursor?.epoch === this.epoch &&
      cursor.sequence >= oldest - 1 &&
      cursor.sequence <= this.sequence
        ? this.ring
            .filter(({ frame }) => frame.sequence > cursor.sequence)
            .map(({ frame }) => frame)
        : [this.snapshot()];
    // Same-cursor reconnect still needs a handshake to mark the link synchronized.
    if (replay.length === 0) replay.push(this.snapshot());
    const guarded = (frame: RemoteFrame) => {
      if (frame.sequence <= last) return;
      last = frame.sequence;
      listener(frame);
    };
    this.listeners.add(guarded);
    try {
      for (const frame of replay) listener(frame);
    } catch {
      this.listeners.delete(guarded);
    }
    return () => this.listeners.delete(guarded);
  }
  private deliver(): void {
    this.scheduled = false;
    const pending = this.pending;
    this.pending = [];
    for (const frame of pending) {
      for (const listener of this.listeners) {
        try {
          listener(frame);
        } catch {
          this.listeners.delete(listener);
        }
      }
    }
  }
  close(): void {
    this.listeners.clear();
    this.pending = [];
  }
}
