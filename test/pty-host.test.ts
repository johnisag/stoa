// Isolated daemon socket so this file's daemon doesn't collide with other
// daemon-using test files running in parallel workers (global pipe/socket).
process.env.STOA_PTY_HOST_NAME = "stoa-pty-host-test-host";

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { startHost, stopHost } from "@/lib/session-backend/pty/host";
import { HostClient } from "@/lib/session-backend/pty/host-client";
import { _resetRegistryForTests } from "@/lib/session-backend/pty/registry";

// The host runs in-process here; each HostClient connects over the real socket,
// so this exercises the true IPC path. A fresh client simulates the web server
// restarting (new process attaching to the surviving daemon).

beforeAll(async () => {
  const started = await startHost();
  expect(started).toBe(true);
});

afterAll(async () => {
  _resetRegistryForTests();
  await stopHost();
});

afterEach(() => {
  _resetRegistryForTests();
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
});

function client_close(c: HostClient) {
  c.close();
}
