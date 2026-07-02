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
    expect(detail).toEqual({
      status: "dead",
      lastLine: "",
      rateLimit: null,
      prompt: null,
    });
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
    const s = spawnSession("vt-err", {
      binary: "node",
      args: printAndHold(
        "Error code: 400 - {'type': 'invalid_request_error'}\r\n"
      ),
      cwd: process.cwd(),
    });
    expect(
      await waitFor(() => s.capture().includes("invalid_request_error"), 12000)
    ).toBe(true);
    const ok = await waitFor(
      async () => (await statusDetector.getStatus("vt-err")) === "error",
      12000
    );
    expect(ok).toBe(true);
    killSession("vt-err");
  });
});

describe("rate-limit vs error precedence (#51)", () => {
  // Regression: a screen carrying BOTH error wording ("API Error", "Rate limit
  // exceeded") AND a rate-limit notice WITH a reset time used to classify as
  // "error" — and the auto-resume tick never nudges an errored session, so the
  // episode was never resumed. With a reset time present, the rate-limited
  // classification must win (a count-down-and-resume wait, not a failed turn).
  it("a rate-limit screen WITH a reset time is NOT classified as error", async () => {
    const s = spawnSession("vt-rl-reset", {
      binary: "node",
      args: printAndHold(
        '  ⎿ API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded."}}\r\n' +
          "  You've reached your usage limit. Your rate limit will reset at 3:30 pm.\r\n"
      ),
      cwd: process.cwd(),
    });
    expect(
      await waitFor(() => s.capture().includes("reset at 3:30 pm"), 12000)
    ).toBe(true);
    // Must settle on waiting/idle (parked at the limit) — never wedge on error.
    const settled = await waitFor(async () => {
      const st = await statusDetector.getStatus("vt-rl-reset");
      return st === "waiting" || st === "idle";
    }, 12000);
    expect(settled).toBe(true);
    const detail = await statusDetector.getStatusDetail("vt-rl-reset");
    expect(detail.status).not.toBe("error");
    // The rate-limit state (with its parsed reset) rides the same capture, so
    // the auto-resume tick can count down and act.
    expect(detail.rateLimit).not.toBeNull();
    expect(detail.rateLimit?.resetAt).not.toBeNull();
    killSession("vt-rl-reset");
  });

  it("error + rate-limit wording WITHOUT a reset time still classifies as error", async () => {
    // No reset time → nothing to count down to; the error classification (and
    // its needs-attention surfacing) must be preserved.
    const s = spawnSession("vt-rl-noreset", {
      binary: "node",
      args: printAndHold(
        "You're out of extra usage. HTTP 429 Too Many Requests.\r\n"
      ),
      cwd: process.cwd(),
    });
    expect(
      await waitFor(() => s.capture().includes("Too Many Requests"), 12000)
    ).toBe(true);
    const ok = await waitFor(
      async () => (await statusDetector.getStatus("vt-rl-noreset")) === "error",
      12000
    );
    expect(ok).toBe(true);
    killSession("vt-rl-noreset");
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

  it("does NOT bucket pure rate-limit phrasing as error (#51 — the rate-limit detector owns it)", () => {
    // These are all caught by detectRateLimit (lib/rate-limit.ts) and must
    // surface as a recoverable rate-limited state, never as a red error.
    expect(hit("rate limit exceeded")).toBe(false);
    expect(hit("rate limit exhausted")).toBe(false);
    expect(hit("You've reached your usage limit")).toBe(false);
    expect(hit("Your rate limit will reset at 3:30 pm")).toBe(false);
  });
});
