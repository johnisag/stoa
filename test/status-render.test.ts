// Exercise the detector against the in-process registry this test spawns into.
// Force the in-process pty backend on EVERY OS: without STOA_BACKEND=pty,
// POSIX defaults to the tmux backend, so statusDetector would shell out to tmux
// (absent on CI) instead of reading the registry these tests populate. PTY_HOST=0
// keeps it Tier-1 (no daemon).
process.env.STOA_BACKEND = "pty";
process.env.STOA_PTY_HOST = "0";

import { describe, it, expect, afterEach } from "vitest";
import {
  spawnSession,
  killSession,
  _resetRegistryForTests,
} from "@/lib/session-backend/pty/registry";
import { statusDetector, ERROR_PATTERNS } from "@/lib/status-detector";

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

// node -e program that prints `text`, then stays alive so we can inspect it.
function printAndHold(text: string): string[] {
  return [
    "-e",
    `process.stdout.write(${JSON.stringify(text)}); setInterval(() => {}, 1000)`,
  ];
}

describe("VT rendering — the status-detection safety net", () => {
  it("collapses a self-overwriting spinner to a single rendered line", async () => {
    // Writes \r + frame repeatedly with NO newline: a real terminal overwrites
    // the same row. If capture() returned the raw byte stream instead of the
    // rendered grid, we'd see 20 'working' lines and status detection would break.
    const code = `let i=0;const t=setInterval(()=>{process.stdout.write('\\r'+['|','/','-','\\\\'][i%4]+' working');if(++i>=20)clearInterval(t)},5);setTimeout(()=>{},3000)`;
    const s = spawnSession("vt-spin", {
      binary: "node",
      args: ["-e", code],
      cwd: process.cwd(),
    });
    await waitFor(() => s.capture().includes("working"));
    const occurrences = (s.capture().match(/working/g) || []).length;
    expect(occurrences).toBe(1);
    killSession("vt-spin");
  });

  it("detects a busy agent ('esc to interrupt') as running", async () => {
    spawnSession("vt-busy", {
      binary: "node",
      args: printAndHold("Working... (123 tokens) esc to interrupt\r\n"),
      cwd: process.cwd(),
    });
    const ok = await waitFor(
      async () => (await statusDetector.getStatus("vt-busy")) === "running"
    );
    expect(ok).toBe(true);
    killSession("vt-busy");
  });

  it("detects a confirmation prompt ('[Y/n]') as waiting", async () => {
    spawnSession("vt-wait", {
      binary: "node",
      args: printAndHold("Do you want to proceed? [Y/n]\r\n"),
      cwd: process.cwd(),
    });
    const ok = await waitFor(
      async () => (await statusDetector.getStatus("vt-wait")) === "waiting"
    );
    expect(ok).toBe(true);
    killSession("vt-wait");
  });
});

describe("getStatusDetail — status + last line from a single capture", () => {
  it("returns the status and the last rendered non-empty line together", async () => {
    spawnSession("detail-ok", {
      binary: "node",
      args: printAndHold("scrollback noise\r\nLASTLINE_MARKER_7\r\n"),
      cwd: process.cwd(),
    });
    const got = await waitFor(async () => {
      const d = await statusDetector.getStatusDetail("detail-ok");
      return d.lastLine.includes("LASTLINE_MARKER_7");
    });
    expect(got).toBe(true);
    const detail = await statusDetector.getStatusDetail("detail-ok");
    expect(detail.lastLine).toContain("LASTLINE_MARKER_7");
    expect(["running", "waiting", "idle", "error"]).toContain(detail.status);
    killSession("detail-ok");
  });

  it("reports a non-existent session as dead with an empty last line", async () => {
    const detail = await statusDetector.getStatusDetail("detail-missing");
    expect(detail).toEqual({ status: "dead", lastLine: "" });
  });
});

describe("multi-client fan-out + sizing", () => {
  it("delivers output to every subscriber", async () => {
    const s = spawnSession("fan", {
      binary: "node",
      args: printAndHold("FANOUT_MARKER_9\r\n"),
      cwd: process.cwd(),
    });
    let a = "";
    let b = "";
    s.onOutput((d) => (a += d));
    s.onOutput((d) => (b += d));
    await waitFor(
      () => a.includes("FANOUT_MARKER_9") && b.includes("FANOUT_MARKER_9")
    );
    expect(a).toContain("FANOUT_MARKER_9");
    expect(b).toContain("FANOUT_MARKER_9");
    killSession("fan");
  });

  it("tracks multiple client sizes without error (min-size policy)", () => {
    const s = spawnSession("size", {
      binary: "node",
      args: printAndHold(""),
      cwd: process.cwd(),
    });
    const big = s.addClient(120, 40);
    const small = s.addClient(80, 24); // pty resizes down to the smaller viewer
    s.resizeClient(big, 100, 30);
    s.removeClient(small); // can grow back toward the remaining client
    s.removeClient(big);
    expect(s.alive).toBe(true);
    killSession("size");
  });
});

describe("error-state detection", () => {
  it("classifies a structured error on the rendered screen as 'error'", async () => {
    spawnSession("vt-err", {
      binary: "node",
      args: printAndHold(
        "Error code: 400 - {'type': 'invalid_request_error'}\r\n"
      ),
      cwd: process.cwd(),
    });
    const ok = await waitFor(
      async () => (await statusDetector.getStatus("vt-err")) === "error"
    );
    expect(ok).toBe(true);
    killSession("vt-err");
  });
});

describe("ERROR_PATTERNS (session/provider failures only, kept narrow)", () => {
  const hit = (s: string) => ERROR_PATTERNS.some((p) => p.test(s));

  it("matches provider/session-failure envelopes", () => {
    expect(
      hit("Error: Error code: 400 - {'type': 'invalid_request_error'}")
    ).toBe(true);
    expect(hit("You're out of extra usage. Add more at ...")).toBe(true);
    expect(hit("quota exceeded")).toBe(true);
    expect(hit("rate limit exceeded")).toBe(true);
    expect(hit("insufficient_quota")).toBe(true);
  });

  it("does NOT flag errors the agent prints while doing its job", () => {
    // A stack trace or HTTP code in normal agent output is the agent working on
    // YOUR code — not the session failing. These must NOT wedge a session red.
    expect(hit("Traceback (most recent call last):")).toBe(false);
    expect(hit("A 404 returns Error code: 404 to the client.")).toBe(false);
    expect(hit("'type': 'invalid_request_error'")).toBe(false); // mention, no HTTP code
    expect(hit("I fixed the error and all tests pass.")).toBe(false);
    expect(hit("> ")).toBe(false);
  });
});
