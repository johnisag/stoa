import type { AttachHandle, AttachSpawn, PtyTransport } from "./transport";

/** Where a client attachment forwards pty events (a WebSocket, in production). */
export interface AttachSink {
  output(data: string): void;
  exit(code: number): void;
  error(message: string): void;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Per-client attach state machine shared by every pty terminal socket.
 *
 * `attach()` is async (it awaits `transport.attachStream`), and a single client
 * sends MORE THAN ONE attach per (re)connect — the Pane's `onConnected` handler
 * plus the connection hook's own re-attach. When two attaches overlap, the older
 * one's `await` resolves AFTER the newer one has already run, so the naive
 * "detach the previous handle, then overwrite it" approach leaks: at the moment
 * the second attach runs, the first handle is still null (its await hasn't
 * assigned it), so nothing is detached; then both handles end up subscribed and
 * every byte fans out twice — the doubled echo/output, the stranded "Working"
 * line, the 3× warnings.
 *
 * A monotonic sequence number guards each await: an attach only keeps its handle
 * if it is still the newest attach when `attachStream` resolves; otherwise it
 * detaches the just-created handle instead of leaking it. `detach()` bumps the
 * sequence too, so an attach that resolves after the socket closed cleans itself
 * up rather than streaming into a dead sink. This class is the single seam where
 * attach ordering is enforced; `server.ts` is just the WebSocket wiring.
 */
export class AttachSession {
  private currentKey: string | null = null;
  private handle: AttachHandle | null = null;
  private lastSize = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
  private attachSeq = 0;
  // Read-only observer (mini-terminal preview): ignores input + resize so it
  // never writes to or shrinks the session it's watching.
  private observer = false;

  constructor(
    private readonly transport: PtyTransport,
    private readonly sink: AttachSink
  ) {}

  /** The session this client is currently bound to (drives write/command). */
  get key(): string | null {
    return this.currentKey;
  }

  async attach(
    key: string,
    spawn?: AttachSpawn,
    observer = false
  ): Promise<void> {
    const seq = ++this.attachSeq;
    // Detach any FULLY-established prior handle synchronously; the seq guard
    // below covers a prior attach that is still in flight.
    this.handle?.detach();
    this.handle = null;
    this.currentKey = key;
    this.observer = observer;
    try {
      const h = await this.transport.attachStream({
        key,
        spawn,
        observer,
        cols: this.lastSize.cols,
        rows: this.lastSize.rows,
        // Stream only while this attach is the newest one. A superseded handle
        // is detached below, but guard here too in case a byte races detach.
        onOutput: (data) => {
          if (seq === this.attachSeq) this.sink.output(data);
        },
        onExit: (code) => {
          if (seq === this.attachSeq) this.sink.exit(code);
        },
      });
      if (seq !== this.attachSeq) {
        // A newer attach (or a detach) started while we awaited — don't leak
        // this subscription, or its onOutput would double every byte.
        h.detach();
        return;
      }
      this.handle = h;
      if (h.snapshot) this.sink.output(h.snapshot);
    } catch (err) {
      if (seq === this.attachSeq) {
        console.error("pty attach failed:", err);
        this.sink.error("Failed to attach session");
      }
    }
  }

  /** Forward raw bytes (input) to the bound session (no-op for observers). */
  write(data: string): void {
    if (this.observer) return;
    if (this.currentKey) this.transport.write(this.currentKey, data);
  }

  resize(cols: number, rows: number): void {
    if (this.observer) return; // observers never resize the watched session
    this.lastSize = { cols, rows };
    this.handle?.resize(cols, rows);
  }

  /** Disconnect this client; leaves the session running. Supersedes any
   * in-flight attach so it can't stream into a closed sink. */
  detach(): void {
    this.attachSeq++;
    this.handle?.detach();
    this.handle = null;
  }
}
