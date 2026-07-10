// Isolated daemon socket so this file's daemon doesn't collide with other
// daemon-using test files running in parallel workers (global pipe/socket).
process.env.STOA_PTY_HOST_NAME = `stoa-pty-host-test-host-${process.pid}`;
// Force the pty backend so the Tier-2→Tier-1 fallback contract below resolves a
// pty backend on the POSIX CI runners too (default is tmux on macOS/Linux).
process.env.STOA_BACKEND = "pty";
// Disable the audit decorator so getSessionBackend() returns the raw backend
// (the fallback test asserts the transport type directly, not through a wrapper).
process.env.STOA_AUDIT = "0";

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import {
  startHost,
  stopHost,
  installProcessGuards,
  uninstallProcessGuards,
} from "@/lib/session-backend/pty/host";
import { HostClient } from "@/lib/session-backend/pty/host-client";
import {
  _resetRegistryForTests,
  getSession,
} from "@/lib/session-backend/pty/registry";
import {
  getSessionBackend,
  resetSessionBackend,
  usePtyHost,
} from "@/lib/session-backend";

// The host runs in-process here; each HostClient connects over the real socket,
// so this exercises the true IPC path. A fresh client simulates the web server
// restarting (new process attaching to the surviving daemon).

beforeAll(async () => {
  const started = await startHost();
  expect(started).toBe(true);
});

afterAll(async () => {
  await _resetRegistryForTests();
  await stopHost();
});

afterEach(async () => {
  await _resetRegistryForTests();
});

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 6000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return fn();
}

describe("pty-host daemon (Tier 2)", () => {
  it("spawns, streams output, and serves a capture over IPC", async () => {
    const client = new HostClient();
    const marker = "HOST_IPC_OK_91";
    await client.spawn("host-stream", {
      binary: "node",
      args: [
        "-e",
        `process.stdout.write('${marker}\\r\\n'); setTimeout(()=>{},5000)`,
      ],
      cwd: process.cwd(),
    });

    let streamed = "";
    const { detach } = await client.attach(
      "host-stream",
      (d) => (streamed += d),
      () => {}
    );

    await waitFor(() => streamed.includes(marker));
    expect(streamed).toContain(marker);

    const cap = await client.capture("host-stream", 50);
    expect(cap).toContain(marker);

    detach();
    await client.kill("host-stream");
    client.close();
  });

  it("session survives a client disconnect (simulated server restart)", async () => {
    const clientA = new HostClient();
    const marker = "SURVIVES_RESTART_55";
    await clientA.spawn("host-survive", {
      binary: "node",
      // Stay alive, and keep a marker in the buffer for the next client to read.
      args: [
        "-e",
        `process.stdout.write('${marker}\\r\\n'); setInterval(()=>{},1000)`,
      ],
      cwd: process.cwd(),
    });
    await waitFor(async () =>
      (await clientA.capture("host-survive", 50)).includes(marker)
    );

    // Simulate the web server going away.
    clientA.close();
    await new Promise((r) => setTimeout(r, 150));

    // A brand-new client (new "server process") finds the session still alive,
    // with its scrollback intact.
    const clientB = new HostClient();
    expect(await clientB.exists("host-survive")).toBe(true);
    const cap = await clientB.capture("host-survive", 50);
    expect(cap).toContain(marker);
    expect(await clientB.list()).toContain("host-survive");

    await clientB.kill("host-survive");
    client_close(clientB);
  });

  it("recovers transparently when its socket drops (daemon stays up)", async () => {
    const client = new HostClient();
    const marker = "RECONNECT_MARK_33";
    await client.spawn("host-recon", {
      binary: "node",
      args: [
        "-e",
        `process.stdout.write('${marker}\\r\\n'); setInterval(()=>{},1000)`,
      ],
      cwd: process.cwd(),
    });
    let streamed = "";
    const { detach } = await client.attach(
      "host-recon",
      (d) => (streamed += d),
      () => {}
    );
    await waitFor(() => streamed.includes(marker));

    // Forcibly drop the client's socket while the daemon keeps running.
    streamed = "";
    (
      client as unknown as { socket: { destroy(): void } | null }
    ).socket?.destroy();
    await new Promise((r) => setTimeout(r, 100));

    // The next call auto-reconnects, re-validates, and re-attaches the live
    // subscription (repainting its snapshot to the listener). The session is
    // intact across the drop.
    expect(await client.exists("host-recon")).toBe(true);
    const cap = await client.capture("host-recon", 50);
    expect(cap).toContain(marker);
    await waitFor(() => streamed.includes(marker)); // resubscribe repainted it
    expect(streamed).toContain(marker);

    detach();
    await client.kill("host-recon");
    client.close();
  });

  it("tracks observer vs sizing attaches per key (drives the resubscribe flag)", async () => {
    // After a reconnect, resubscribeAll must re-send the right observer flag:
    // observer-only keys re-attach as observers (no sizing client), but a key
    // with any real viewer re-attaches as a sizing client. This locks the
    // per-key bookkeeping that decides that.
    const client = new HostClient();
    await client.spawn("host-obs", {
      binary: "node",
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
    });
    const probe = client as unknown as {
      observerForKey(k: string): boolean;
    };

    const obs = await client.attach(
      "host-obs",
      () => {},
      () => {},
      true
    );
    expect(probe.observerForKey("host-obs")).toBe(true); // observer-only

    const viewer = await client.attach(
      "host-obs",
      () => {},
      () => {},
      false
    );
    expect(probe.observerForKey("host-obs")).toBe(false); // a sizing client exists

    viewer.detach();
    expect(probe.observerForKey("host-obs")).toBe(true); // back to observer-only

    obs.detach();
    await client.kill("host-obs");
    client.close();
  });

  it("an observer attach does NOT steal the viewer's resize slot (#2)", async () => {
    // Repro of the Windows live-wall bug: a worker open full-screen (a real sizing
    // viewer) AND observed in the live wall (an observer attach on the SAME daemon
    // connection). The observer must not evict the viewer's sizing client, or the
    // viewer's resize stops taking effect on the pty.
    const client = new HostClient();
    await client.spawn("host-resize", {
      binary: "node",
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
    });

    // Viewer attaches at 80x24 (registers a sizing client).
    const viewer = await client.attach(
      "host-resize",
      () => {},
      () => {},
      false,
      80,
      24
    );
    // Live-wall observer attaches the SAME key on the SAME connection.
    const obs = await client.attach(
      "host-resize",
      () => {},
      () => {},
      true
    );

    // The viewer resizes — this MUST reach the pty. Pre-fix, the observer attach
    // had nulled the viewer's sizing slot, so this resize was silently ignored.
    client.resize("host-resize", 120, 40);
    const session = getSession("host-resize");
    const applied = await waitFor(
      () => session?.cols === 120 && session?.rows === 40
    );
    expect(applied).toBe(true);
    expect(session?.cols).toBe(120);
    expect(session?.rows).toBe(40);

    viewer.detach();
    obs.detach();
    await client.kill("host-resize");
    client.close();
  });

  it("observer-FIRST then viewer still gives the viewer a working resize slot (#2)", async () => {
    // The natural live-wall flow: the wall is already observing the worker, THEN
    // you open it full-screen. The later viewer attach must register a real sizing
    // client even though an observer got there first.
    const client = new HostClient();
    await client.spawn("host-resize2", {
      binary: "node",
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
    });
    const obs = await client.attach(
      "host-resize2",
      () => {},
      () => {},
      true
    );
    const viewer = await client.attach(
      "host-resize2",
      () => {},
      () => {},
      false,
      80,
      24
    );
    client.resize("host-resize2", 132, 43);
    const session = getSession("host-resize2");
    const applied = await waitFor(
      () => session?.cols === 132 && session?.rows === 43
    );
    expect(applied).toBe(true);

    obs.detach();
    viewer.detach();
    await client.kill("host-resize2");
    client.close();
  });

  it("re-key daemon subscriptions on rename so detach under the new key works", async () => {
    const client = new HostClient();
    await client.spawn("host-rename-old", {
      binary: "node",
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
    });

    await client.rename("host-rename-old", "host-rename-new");
    expect(await client.exists("host-rename-old")).toBe(false);
    expect(await client.exists("host-rename-new")).toBe(true);

    // Attach under the new key and detach: this must not throw and the session
    // must remain alive (the daemon re-keyed its subscription bookkeeping).
    const { detach } = await client.attach(
      "host-rename-new",
      () => {},
      () => {}
    );
    detach();
    expect(await client.exists("host-rename-new")).toBe(true);

    await client.kill("host-rename-new");
    client.close();
  });

  it("delivers an exit frame over IPC when the agent process exits", async () => {
    // Contract: when a session's pty exits, the daemon pushes an `exit` frame to
    // every attached client (it doesn't just silently reap). The browser relies
    // on this to flip a card to \"exited\" without polling.
    const client = new HostClient();
    let exitCode: number | null = null;
    await client.spawn("host-exit", {
      binary: "node",
      // Live briefly so attach lands first, then exit with a distinct code.
      args: ["-e", "setTimeout(() => process.exit(7), 150)"],
      cwd: process.cwd(),
    });
    await client.attach(
      "host-exit",
      () => {},
      (code) => (exitCode = code)
    );

    const got = await waitFor(() => exitCode !== null);
    expect(got).toBe(true);
    expect(exitCode).toBe(7);
    client.close();
  });

  it("reports a session that exited during a socket drop as gone, not alive", async () => {
    // Regression: a short-lived agent that exits WHILE the client's socket is
    // dropped must not repaint as alive after the transparent reconnect. The
    // daemon reaps it on exit, so the reconnecting client's exists() must read
    // false (the listener bookkeeping survives the drop, but the session does not).
    const client = new HostClient();
    await client.spawn("host-exit-drop", {
      binary: "node",
      args: ["-e", "setTimeout(() => process.exit(0), 250)"],
      cwd: process.cwd(),
    });
    await client.attach(
      "host-exit-drop",
      () => {},
      () => {}
    );

    // Drop the socket, then let the process exit while disconnected.
    (
      client as unknown as { socket: { destroy(): void } | null }
    ).socket?.destroy();
    await new Promise((r) => setTimeout(r, 100)); // let the close settle

    // The next calls auto-reconnect; once the pty exits the daemon reaps it, so
    // exists() must settle on false (poll — node-pty's exit can lag the timer).
    const gone = await waitFor(
      async () => !(await client.exists("host-exit-drop"))
    );
    expect(gone).toBe(true);
    expect(await client.list()).not.toContain("host-exit-drop");
    client.close();
  });
});

describe("Tier-2 → Tier-1 fallback (no split brain)", () => {
  it("re-resolves the backend transport when host mode is disabled mid-flight", () => {
    // server.ts probes the daemon once at startup; if it's unreachable it sets
    // STOA_PTY_HOST=0 and calls resetSessionBackend() so the WHOLE process
    // agrees on Tier 1 — even a backend cached before the flip. Lock that the
    // selection actually flips HostTransport → LocalTransport on that signal.
    const prev = process.env.STOA_PTY_HOST;
    try {
      process.env.STOA_PTY_HOST = "1";
      resetSessionBackend();
      expect(usePtyHost()).toBe(true);
      const tier2 = getSessionBackend() as unknown as {
        transport: { constructor: { name: string } };
      };
      expect(tier2.transport.constructor.name).toBe("HostTransport");

      // Simulate the probe failing: host mode off + re-resolve.
      process.env.STOA_PTY_HOST = "0";
      resetSessionBackend();
      expect(usePtyHost()).toBe(false);
      const tier1 = getSessionBackend() as unknown as {
        transport: { constructor: { name: string } };
      };
      expect(tier1.transport.constructor.name).toBe("LocalTransport");
    } finally {
      if (prev === undefined) delete process.env.STOA_PTY_HOST;
      else process.env.STOA_PTY_HOST = prev;
      resetSessionBackend();
    }
  });
});

describe("Tier-2 daemon process guards (keep-alive)", () => {
  it("installs and removes the uncaughtException / unhandledRejection handlers", () => {
    // The daemon owns every live session; one unhandled throw must not crash it.
    // The entry point installs these last-resort guards. Lock that install adds
    // exactly one of each (idempotently) and uninstall fully removes them — so
    // the test runner's own handlers aren't left shadowed after this file.
    const before = {
      ue: process.listenerCount("uncaughtException"),
      ur: process.listenerCount("unhandledRejection"),
    };
    try {
      installProcessGuards();
      installProcessGuards(); // idempotent
      expect(process.listenerCount("uncaughtException")).toBe(before.ue + 1);
      expect(process.listenerCount("unhandledRejection")).toBe(before.ur + 1);
    } finally {
      uninstallProcessGuards();
    }
    expect(process.listenerCount("uncaughtException")).toBe(before.ue);
    expect(process.listenerCount("unhandledRejection")).toBe(before.ur);
  });

  it("the installed handlers swallow + log instead of rethrowing (keep-alive semantics)", () => {
    // The listenerCount test above locks the bookkeeping; this locks the BEHAVIOR
    // that matters — the handler bodies log and DON'T rethrow, so the daemon
    // stays up. Invoke the freshly-registered listeners directly (rather than
    // emitting on the real process, which would trip vitest's own handlers).
    const ueBefore = new Set(process.listeners("uncaughtException"));
    const urBefore = new Set(process.listeners("unhandledRejection"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      installProcessGuards();
      const ue = process
        .listeners("uncaughtException")
        .find((l) => !ueBefore.has(l)) as
        ((e: unknown, o?: string) => void) | undefined;
      const ur = process
        .listeners("unhandledRejection")
        .find((l) => !urBefore.has(l)) as ((r: unknown) => void) | undefined;
      expect(ue).toBeDefined();
      expect(ur).toBeDefined();

      // Neither may throw — that's the whole point of the keep-alive guard.
      expect(() => ue!(new Error("boom"), "uncaughtException")).not.toThrow();
      expect(() => ur!(new Error("rejected"))).not.toThrow();
      expect(errSpy).toHaveBeenCalledTimes(2);
    } finally {
      uninstallProcessGuards();
      errSpy.mockRestore();
    }
  });
});

function client_close(c: HostClient) {
  c.close();
}
