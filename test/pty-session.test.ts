import { describe, it, expect, afterEach, vi } from "vitest";
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  spawnSession,
  getSession,
  hasSession,
  killSession,
  renameSession,
  _resetRegistryForTests,
} from "@/lib/session-backend/pty/registry";

afterEach(() => {
  _resetRegistryForTests();
});

/** Wait until predicate is true or timeout. */
async function waitFor(fn: () => boolean, ms = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

describe("pty registry / PtySession", () => {
  it("spawns a process and exposes rendered capture + raw buffer + live stream", async () => {
    const marker = "PTY_RENDER_OK_77";
    const session = spawnSession("test-render", {
      binary: "node",
      args: ["-e", `process.stdout.write('${marker}\\r\\n')`],
      cwd: process.cwd(),
    });

    let streamed = "";
    session.onOutput((d) => {
      streamed += d;
    });

    await waitFor(() => session.capture(50).includes(marker));

    // Rendered grid (what the status detector reads) contains the text...
    expect(session.capture(50)).toContain(marker);
    // ...as does the raw replay buffer (what repaints a reconnecting client)...
    expect(session.getRawBuffer()).toContain(marker);
    // ...and the live stream that was fanned out to subscribers.
    expect(streamed).toContain(marker);
    // serialize() repaints the current screen (used for reconnect/switch).
    expect(session.serialize()).toContain(marker);
  });

  it("keeps the raw fallback buffer bounded under heavy output", async () => {
    // Emit ~1 MB across many chunks. The raw buffer is a capped fallback (64 KiB,
    // trimmed at a 128 KiB high-water mark), so it must never grow unbounded —
    // this locks the amortized-trim fix against a regression to per-chunk slicing
    // or an uncapped buffer.
    const session = spawnSession("test-bounded", {
      binary: "node",
      args: [
        "-e",
        "for(let i=0;i<8000;i++)process.stdout.write('x'.repeat(128));setTimeout(()=>{},10000)",
      ],
      cwd: process.cwd(),
    });
    // Wait until enough output has streamed that trimming must have kicked in...
    await waitFor(() => session.getRawBuffer().length >= 64 * 1024);
    // ...then give it more time to flush the full ~1 MB and assert the cap held.
    await new Promise((r) => setTimeout(r, 500));
    const len = session.getRawBuffer().length;
    expect(len).toBeGreaterThan(0);
    expect(len).toBeLessThanOrEqual(128 * 1024);
    killSession("test-bounded");
  });

  it("serialize() falls back to the raw buffer when the serializer throws", async () => {
    // serialize() is the primary repaint path; the raw buffer exists ONLY for the
    // rare case the addon throws. Since #1 shrank that buffer, exercise the catch
    // branch explicitly: force the serializer to throw and assert we return the
    // raw buffer (still holding recent output) rather than crashing.
    const marker = "FALLBACK_MARK_42";
    const session = spawnSession("test-fallback", {
      binary: "node",
      args: [
        "-e",
        `process.stdout.write('${marker}\\r\\n'); setTimeout(()=>{},10000)`,
      ],
      cwd: process.cwd(),
    });
    await waitFor(() => session.getRawBuffer().includes(marker));
    const spy = vi
      .spyOn(SerializeAddon.prototype, "serialize")
      .mockImplementation(() => {
        throw new Error("serialize boom");
      });
    try {
      const out = session.serialize();
      expect(out).toBe(session.getRawBuffer());
      expect(out).toContain(marker);
    } finally {
      spy.mockRestore();
    }
    killSession("test-fallback");
  });

  it("dedupes a no-op resize so it never SIGWINCHes the pty (Android typing-lag guard)", () => {
    // Each pty.resize() raises SIGWINCH, making a TUI repaint its whole screen.
    // Android's soft keyboard fires visualViewport `resize` repeatedly while
    // typing, re-sending an identical size every time; without this guard each
    // one floods the terminal with redraw and buries the keystroke ("typing lag").
    const session = spawnSession("test-resize", {
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: process.cwd(),
    });
    // Reach into the live pty to count the resizes that actually reach the OS.
    const pty = (
      session as unknown as { pty: { resize: (c: number, r: number) => void } }
    ).pty;
    const spy = vi.spyOn(pty, "resize");

    session.resize(123, 45); // real change — goes through
    session.resize(123, 45); // identical — must be swallowed (no SIGWINCH storm)
    session.resize(123, 45);
    expect(spy).toHaveBeenCalledTimes(1);

    session.resize(124, 46); // genuine new size — passes through again
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(124, 46);

    spy.mockRestore();
    killSession("test-resize");
  });

  it("reaps a session from the registry when its process exits", async () => {
    spawnSession("test-reap", {
      binary: "node",
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
    });
    const gone = await waitFor(() => !hasSession("test-reap"));
    expect(gone).toBe(true);
  });

  it("is idempotent: spawning an existing live key returns the same session", () => {
    const a = spawnSession("test-idem", {
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: process.cwd(),
    });
    const b = spawnSession("test-idem", {
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: process.cwd(),
    });
    expect(b).toBe(a);
    killSession("test-idem");
  });

  it("renames a registry key, preserving the session object", () => {
    const s = spawnSession("test-old", {
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: process.cwd(),
    });
    renameSession("test-old", "test-new");
    expect(hasSession("test-old")).toBe(false);
    expect(getSession("test-new")).toBe(s);
    // The session's own key label is kept in sync (list/listWithActivity use it).
    expect(s.key).toBe("test-new");
    killSession("test-new");
  });

  it("kill removes the session and stops it", () => {
    spawnSession("test-kill", {
      binary: "node",
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: process.cwd(),
    });
    expect(hasSession("test-kill")).toBe(true);
    killSession("test-kill");
    expect(hasSession("test-kill")).toBe(false);
  });

  it("isolates a throwing output subscriber: others still receive + the pty callback never throws (Tier-2 keep-alive)", async () => {
    // The Tier-2 pty-host daemon runs the output fan-out inside node-pty's
    // onData callback, which is OUTSIDE the IPC decoder's try/catch. If one
    // subscriber threw and that escaped, it would crash the daemon and kill
    // EVERY live session. Lock that a throwing listener can't abort the fan-out
    // to the others (and, by construction, can't escape the pty callback).
    const marker = "FANOUT_ISOLATE_88";
    const session = spawnSession("test-fanout", {
      binary: "node",
      args: [
        "-e",
        `setInterval(()=>process.stdout.write('${marker}\\r\\n'),20)`,
      ],
      cwd: process.cwd(),
    });

    let good = "";
    session.onOutput(() => {
      throw new Error("subscriber boom"); // hostile/buggy subscriber, first in set
    });
    session.onOutput((d) => {
      good += d; // must still receive despite the thrower above
    });

    const got = await waitFor(() => good.includes(marker));
    expect(got).toBe(true);
    expect(good).toContain(marker);
    killSession("test-fanout");
  });
});
