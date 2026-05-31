// Exercise Hermes banner session-id capture against the in-process pty registry.
// Force the in-process pty backend on EVERY OS (POSIX defaults to tmux, which is
// absent on CI). STOA_PTY_HOST=0 keeps it Tier-1 (no daemon).
process.env.STOA_BACKEND = "pty";
process.env.STOA_PTY_HOST = "0";

import { describe, it, expect, afterEach } from "vitest";
import {
  spawnSession,
  killSession,
  _resetRegistryForTests,
} from "@/lib/session-backend/pty/registry";
import { statusDetector, HERMES_SESSION_ID_RE } from "@/lib/status-detector";

afterEach(() => _resetRegistryForTests());

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 6000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return fn();
}

// Print a Hermes-style banner line (with leading whitespace, as the real TUI
// renders it indented under the ASCII art), then stay alive for inspection.
function bannerArgs(id: string): string[] {
  return [
    "-e",
    `process.stdout.write('   Session: ${id}\\r\\n'); setInterval(() => {}, 1000)`,
  ];
}

describe("Hermes banner session-id capture", () => {
  it("captures the session id from the rendered banner (and memoizes it)", async () => {
    const id = "20260531_133925_98d9fc";
    const name = "hermes-aaaaaaaa-1111-2222-3333-444444444444";
    spawnSession(name, {
      binary: "node",
      args: bannerArgs(id),
      cwd: process.cwd(),
    });

    // getStatus() drives capturePane(), which extracts + memoizes the id.
    await waitFor(async () => {
      await statusDetector.getStatus(name);
      return statusDetector.getHermesSessionId(name) === id;
    });

    expect(statusDetector.getHermesSessionId(name)).toBe(id);
    killSession(name);
  });

  it("returns null when the session prints no banner", async () => {
    const name = "hermes-bbbbbbbb-1111-2222-3333-444444444444";
    spawnSession(name, {
      binary: "node",
      args: [
        "-e",
        "process.stdout.write('no session line here\\r\\n'); setInterval(() => {}, 1000)",
      ],
      cwd: process.cwd(),
    });

    // Drive polls until the output is definitely captured, then assert no id.
    await waitFor(async () => {
      await statusDetector.getStatus(name);
      return (await statusDetector.capturePane(name)).includes(
        "no session line"
      );
    });

    expect(statusDetector.getHermesSessionId(name)).toBeNull();
    killSession(name);
  });
});

describe("HERMES_SESSION_ID_RE (load-bearing pattern)", () => {
  it("matches the banner id, tolerating leading glyphs/whitespace and hex length", () => {
    expect(
      "   Session: 20260531_133925_98d9fc".match(HERMES_SESSION_ID_RE)?.[1]
    ).toBe("20260531_133925_98d9fc");
    expect(
      "│ Session: 20240115_143022_abc123 │".match(HERMES_SESSION_ID_RE)?.[1]
    ).toBe("20240115_143022_abc123");
    expect(
      "Session: 20260420_212246_78d2848f".match(HERMES_SESSION_ID_RE)?.[1]
    ).toBe("20260420_212246_78d2848f");
  });

  it("does not match a Claude-style UUID or junk session line", () => {
    expect(
      HERMES_SESSION_ID_RE.test("Session: 550e8400-e29b-41d4-a716-446655440000")
    ).toBe(false);
    expect(HERMES_SESSION_ID_RE.test("Session: not-an-id")).toBe(false);
  });
});
