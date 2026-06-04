/**
 * Read-only observer attach (the mini-terminal preview primitive): it must
 * stream output + a snapshot but NEVER register as a sizing client, so watching
 * a worker can't shrink its pty for the real viewer. Two layers:
 *  - AttachSession (unit, mock transport): observer ignores input + resize.
 *  - LocalTransport + a real PtySession (integration): an observer doesn't move
 *    the pty size, while a normal client still does (min-size policy).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { AttachSession } from "@/lib/session-backend/pty/attach-session";
import type {
  PtyTransport,
  AttachRequest,
} from "@/lib/session-backend/pty/transport";
import { LocalTransport } from "@/lib/session-backend/pty/transport";
import {
  getSession,
  _resetRegistryForTests,
} from "@/lib/session-backend/pty/registry";

const ALIVE = ["-e", "setInterval(() => {}, 1000)"];

describe("AttachSession — observer mode is read-only", () => {
  function harness() {
    const calls = {
      attaches: [] as AttachRequest[],
      writes: [] as string[],
      resizes: [] as Array<{ cols: number; rows: number }>,
    };
    const transport = {
      write: (_key: string, data: string) => calls.writes.push(data),
      attachStream: vi.fn(async (req: AttachRequest) => {
        calls.attaches.push(req);
        return {
          snapshot: "",
          resize: (cols: number, rows: number) =>
            calls.resizes.push({ cols, rows }),
          detach: () => {},
        };
      }),
    } as unknown as PtyTransport;
    const session = new AttachSession(transport, {
      output: () => {},
      exit: () => {},
      error: () => {},
    });
    return { calls, session };
  }

  it("passes observer:true to attachStream and swallows input + resize", async () => {
    const { calls, session } = harness();
    await session.attach("k", undefined, true);
    expect(calls.attaches[0].observer).toBe(true);

    session.write("hello");
    session.resize(20, 10);
    expect(calls.writes).toHaveLength(0); // input dropped
    expect(calls.resizes).toHaveLength(0); // never resizes the watched session
  });

  it("a normal (non-observer) attach still forwards input + resize", async () => {
    const { calls, session } = harness();
    await session.attach("k");
    expect(calls.attaches[0].observer).toBeFalsy();

    session.write("hello");
    session.resize(20, 10);
    expect(calls.writes).toEqual(["hello"]);
    expect(calls.resizes).toEqual([{ cols: 20, rows: 10 }]);
  });
});

describe("LocalTransport observer — no sizing contribution", () => {
  afterEach(() => _resetRegistryForTests());

  it("an observer never shrinks the pty, but a real client does", async () => {
    const t = new LocalTransport();

    // Real viewer spawns the session at 100x40.
    const viewer = await t.attachStream({
      key: "obs-1",
      spawn: { binary: "node", args: ALIVE, cwd: process.cwd() },
      cols: 100,
      rows: 40,
      onOutput: () => {},
      onExit: () => {},
    });
    expect(getSession("obs-1")!.cols).toBe(100);
    expect(getSession("obs-1")!.rows).toBe(40);

    // A tiny OBSERVER attaches — gets a snapshot, but must NOT shrink the pty.
    const obs = await t.attachStream({
      key: "obs-1",
      cols: 20,
      rows: 10,
      observer: true,
      onOutput: () => {},
      onExit: () => {},
    });
    expect(typeof obs.snapshot).toBe("string");
    expect(getSession("obs-1")!.cols).toBe(100); // unchanged
    expect(getSession("obs-1")!.rows).toBe(40);

    // Observer resize is a no-op too.
    obs.resize(5, 5);
    expect(getSession("obs-1")!.cols).toBe(100);

    // Contrast: a NORMAL second client at 20x10 does shrink (min-size policy).
    const small = await t.attachStream({
      key: "obs-1",
      cols: 20,
      rows: 10,
      onOutput: () => {},
      onExit: () => {},
    });
    expect(getSession("obs-1")!.cols).toBe(20);

    // Detaching the observer doesn't touch sizing (it owns no client slot).
    obs.detach();
    expect(getSession("obs-1")!.cols).toBe(20);

    viewer.detach();
    small.detach();
  });
});
