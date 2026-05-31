// Isolated daemon socket (see pty-host.test.ts) so parallel daemon-using files
// don't collide on the global pipe/socket.
process.env.AGENT_OS_PTY_HOST_NAME = "agent-os-pty-host-test-backend";

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { PtyBackend } from "@/lib/session-backend/pty-backend";
import {
  LocalTransport,
  HostTransport,
} from "@/lib/session-backend/pty/transport";
import { startHost, stopHost } from "@/lib/session-backend/pty/host";
import { _resetRegistryForTests } from "@/lib/session-backend/pty/registry";

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return fn();
}

const ALIVE = ["-e", "setInterval(() => {}, 1000)"];
const ECHO = [
  "-e",
  "process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => process.stdout.write('GOT:' + d));",
];

// The SAME contract, run against both transports — proving Tier 1 (in-process
// registry) and Tier 2 (host daemon) share one PtyBackend implementation.
function runContract(makeBackend: () => PtyBackend) {
  it("create(argv): spawns a session visible to exists/list/listWithActivity", async () => {
    const backend = makeBackend();
    await backend.create({
      name: "b-1",
      cwd: process.cwd(),
      command: "",
      binary: "node",
      args: ALIVE,
    });
    expect(await backend.exists("b-1")).toBe(true);
    expect(await backend.list()).toContain("b-1");
    const activity = await backend.listWithActivity();
    expect(activity.some((a) => a.name === "b-1")).toBe(true);
    expect(await backend.getPanePath("b-1")).toBeTruthy();
    expect(await backend.getEnv("b-1", "ANYTHING")).toBeNull();
    await backend.kill("b-1");
    expect(await backend.exists("b-1")).toBe(false);
  });

  it("input ops (sendKeysLiteral / pasteText) reach the process stdin", async () => {
    const backend = makeBackend();
    await backend.create({
      name: "b-echo",
      cwd: process.cwd(),
      command: "",
      binary: "node",
      args: ECHO,
    });
    await new Promise((r) => setTimeout(r, 600)); // let node start reading stdin

    // A pty starts in canonical (line) mode, so input is delivered on Enter.
    await backend.sendKeysLiteral("b-echo", "hello");
    await backend.sendEnter("b-echo");
    await waitFor(async () =>
      (await backend.capture("b-echo", { lines: 100 })).includes("GOT:hello")
    );
    expect(await backend.capture("b-echo", { lines: 100 })).toContain(
      "GOT:hello"
    );

    await backend.pasteText("b-echo", "pasted", { enter: true });
    await waitFor(async () =>
      (await backend.capture("b-echo", { lines: 100 })).includes("pasted")
    );
    expect(await backend.capture("b-echo", { lines: 100 })).toContain("pasted");

    await backend.kill("b-echo");
  });

  it("rename moves the session; a no-op rename rejects", async () => {
    const backend = makeBackend();
    await backend.create({
      name: "r-old",
      cwd: process.cwd(),
      command: "",
      binary: "node",
      args: ALIVE,
    });
    await backend.rename("r-old", "r-new");
    expect(await backend.exists("r-new")).toBe(true);
    expect(await backend.exists("r-old")).toBe(false);
    await expect(backend.rename("does-not-exist", "x")).rejects.toThrow();
    await backend.kill("r-new");
  });

  it("capture of a missing session is empty; exists is false", async () => {
    const backend = makeBackend();
    expect(await backend.capture("nope")).toBe("");
    expect(await backend.exists("nope")).toBe(false);
  });
}

describe("PtyBackend over LocalTransport (Tier 1)", () => {
  afterEach(() => _resetRegistryForTests());
  runContract(() => new PtyBackend(new LocalTransport()));
});

describe("PtyBackend over HostTransport (Tier 2)", () => {
  beforeAll(async () => {
    expect(await startHost()).toBe(true);
  });
  afterAll(async () => {
    _resetRegistryForTests();
    await stopHost();
  });
  afterEach(() => _resetRegistryForTests());
  runContract(() => new PtyBackend(new HostTransport()));
});
