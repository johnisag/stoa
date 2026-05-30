import { describe, it, expect, afterEach } from "vitest";
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
});
