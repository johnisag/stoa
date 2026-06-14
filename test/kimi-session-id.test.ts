// Exercise Kimi Code banner session-id capture against the in-process pty registry.
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
import { statusDetector, KIMI_SESSION_ID_RE } from "@/lib/status-detector";

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

// Print a Kimi-style banner line (with leading whitespace, as the real TUI
// renders it indented under the ASCII art), then stay alive for inspection.
function bannerArgs(id: string): string[] {
  return [
    "-e",
    `process.stdout.write('   Session: ${id}\\r\\n'); setInterval(() => {}, 1000)`,
  ];
}

describe("Kimi banner session-id capture", () => {
  it("captures the session id from the rendered banner (and memoizes it)", async () => {
    const id = "session_ca9b5a60-f6da-47f8-b2fa-84805e8c8161";
    const name = "kimi-aaaaaaaa-1111-2222-3333-444444444444";
    spawnSession(name, {
      binary: "node",
      args: bannerArgs(id),
      cwd: process.cwd(),
    });

    // getStatus() drives capturePane(), which extracts + memoizes the id.
    await waitFor(async () => {
      await statusDetector.getStatus(name);
      return statusDetector.getKimiSessionId(name) === id;
    });

    expect(statusDetector.getKimiSessionId(name)).toBe(id);
    killSession(name);
  });

  it("returns null when the session prints no banner", async () => {
    const name = "kimi-bbbbbbbb-1111-2222-3333-444444444444";
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

    expect(statusDetector.getKimiSessionId(name)).toBeNull();
    killSession(name);
  });
});

describe("KIMI_SESSION_ID_RE (load-bearing pattern)", () => {
  it("matches the banner id, tolerating leading glyphs/whitespace", () => {
    expect(
      "   Session: session_ca9b5a60-f6da-47f8-b2fa-84805e8c8161".match(
        KIMI_SESSION_ID_RE
      )?.[1]
    ).toBe("session_ca9b5a60-f6da-47f8-b2fa-84805e8c8161");
    expect(
      "│ Session: session_670b0345-ec99-4395-ac2a-c78fc4ca3291 │".match(
        KIMI_SESSION_ID_RE
      )?.[1]
    ).toBe("session_670b0345-ec99-4395-ac2a-c78fc4ca3291");
  });

  it("does not match a Hermes-style id or junk session line", () => {
    expect(KIMI_SESSION_ID_RE.test("Session: 20260531_133925_98d9fc")).toBe(
      false
    );
    expect(KIMI_SESSION_ID_RE.test("Session: not-an-id")).toBe(false);
  });
});
