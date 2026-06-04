/**
 * Regression lock for the attach-race duplication bug.
 *
 * A pty terminal client sends MORE THAN ONE `attach` per (re)connect (the Pane's
 * onConnected handler + the connection hook's own re-attach). `attach()` awaits
 * `transport.attachStream`, so two attaches overlap: the older one resolves AFTER
 * the newer one ran. Before the sequence guard, both handles stayed subscribed
 * and every byte fanned out twice (doubled echo/output, the stranded "Working"
 * line, 3× warnings). These tests force the overlap with a transport whose
 * attachStream resolution the test controls.
 */
import { describe, it, expect } from "vitest";
import { AttachSession } from "@/lib/session-backend/pty/attach-session";
import type {
  AttachHandle,
  AttachRequest,
  PtyTransport,
} from "@/lib/session-backend/pty/transport";
import type { SessionActivity } from "@/lib/session-backend/types";

interface Rec {
  id: number;
  key: string;
  onOutput: (data: string) => void;
  onExit: (code: number) => void;
  detached: boolean;
  release: () => void;
}

/** A PtyTransport whose attachStream resolves only when the test calls release(). */
class FakeTransport implements PtyTransport {
  recs: Rec[] = [];
  writes: Array<[string, string]> = [];
  private nextId = 0;

  attachStream(req: AttachRequest): Promise<AttachHandle> {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const id = this.nextId++;
    const rec: Rec = {
      id,
      key: req.key,
      onOutput: req.onOutput,
      onExit: req.onExit,
      detached: false,
      release,
    };
    this.recs.push(rec);
    return gate.then(() => ({
      snapshot: `snap:${id}`,
      resize: () => {},
      detach: () => {
        rec.detached = true;
      },
    }));
  }

  write(key: string, data: string): void {
    this.writes.push([key, data]);
  }

  // Unused control-plane methods.
  async spawn(): Promise<void> {}
  async kill(): Promise<void> {}
  async rename(): Promise<void> {}
  async exists(): Promise<boolean> {
    return true;
  }
  async list(): Promise<string[]> {
    return [];
  }
  async listActivity(): Promise<SessionActivity[]> {
    return [];
  }
  async panePath(): Promise<string | null> {
    return null;
  }
  async capture(): Promise<string> {
    return "";
  }
}

function makeSink() {
  const out: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  // Records out.length at each reset() — so resets[0] === 0 proves the reset
  // fired BEFORE any snapshot output (the atomic clear-then-replay).
  const resets: number[] = [];
  return {
    out,
    errors,
    exits,
    resets,
    sink: {
      output: (d: string) => out.push(d),
      exit: (c: number) => exits.push(c),
      error: (m: string) => errors.push(m),
      reset: () => resets.push(out.length),
    },
  };
}

describe("AttachSession — attach-race sequence guard", () => {
  it("a racing re-attach detaches the superseded handle and streams only the winner", async () => {
    const t = new FakeTransport();
    const { out, sink } = makeSink();
    const s = new AttachSession(t, sink);

    // Two attaches to the same key overlap: both start before either resolves.
    const p1 = s.attach("k");
    const p2 = s.attach("k");
    expect(t.recs.length).toBe(2);

    // Resolve oldest-first (the order that triggered the leak).
    t.recs[0].release();
    t.recs[1].release();
    await Promise.all([p1, p2]);

    // Superseded handle detached; winner kept.
    expect(t.recs[0].detached).toBe(true);
    expect(t.recs[1].detached).toBe(false);

    // Only the winner's snapshot reached the sink (no double repaint).
    expect(out).toEqual(["snap:1"]);

    // A byte arriving on BOTH subscriptions reaches the sink exactly once.
    t.recs[0].onOutput("X"); // superseded → dropped
    t.recs[1].onOutput("Y"); // winner → delivered
    expect(out).toEqual(["snap:1", "Y"]);
  });

  it("clears (reset) right BEFORE replaying the snapshot — no layering", async () => {
    const t = new FakeTransport();
    const { out, resets, sink } = makeSink();
    const s = new AttachSession(t, sink);

    const p = s.attach("k");
    t.recs[0].release();
    await p;

    // Snapshot delivered once, preceded by exactly one reset that fired while no
    // output had been sent yet (resets records out.length === 0 at reset time).
    expect(out).toEqual(["snap:0"]);
    expect(resets).toEqual([0]);
  });

  it("holds even when the winner resolves before the superseded attach", async () => {
    const t = new FakeTransport();
    const { out, sink } = makeSink();
    const s = new AttachSession(t, sink);

    const p1 = s.attach("k");
    const p2 = s.attach("k");

    // Resolve newest-first this time — order must not matter.
    t.recs[1].release();
    t.recs[0].release();
    await Promise.all([p1, p2]);

    expect(t.recs[0].detached).toBe(true);
    expect(t.recs[1].detached).toBe(false);
    expect(out).toEqual(["snap:1"]);
  });

  it("a sequential re-attach detaches the prior handle and rebinds the key", async () => {
    const t = new FakeTransport();
    const { out, sink } = makeSink();
    const s = new AttachSession(t, sink);

    const p1 = s.attach("k1");
    t.recs[0].release();
    await p1;
    expect(out).toEqual(["snap:0"]);

    const p2 = s.attach("k2");
    t.recs[1].release();
    await p2;

    expect(t.recs[0].detached).toBe(true); // prior handle released
    expect(t.recs[1].detached).toBe(false);
    expect(s.key).toBe("k2");

    s.write("hello");
    expect(t.writes).toEqual([["k2", "hello"]]);
  });

  it("detach() supersedes an in-flight attach so it can't stream into a closed sink", async () => {
    const t = new FakeTransport();
    const { out, sink } = makeSink();
    const s = new AttachSession(t, sink);

    const p1 = s.attach("k");
    s.detach(); // socket closed while the attach is still awaiting
    t.recs[0].release();
    await p1;

    expect(t.recs[0].detached).toBe(true); // late-resolving handle cleaned up
    expect(out).toEqual([]); // no snapshot streamed after close
    t.recs[0].onOutput("late"); // a racing byte is dropped
    expect(out).toEqual([]);
  });
});
