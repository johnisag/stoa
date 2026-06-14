import { describe, it, expect } from "vitest";
import { KIMI_SESSION_ID_RE } from "@/lib/status-detector";

// Kimi Code prints its session id in the startup banner, the same way Hermes
// does, so Stoa captures it per-session from the rendered screen.
describe("KIMI_SESSION_ID_RE — Kimi Code startup-banner session-id capture", () => {
  it("captures session_<uuid> from the banner 'Session:' line", () => {
    const banner =
      "Welcome to Kimi Code!\n" +
      "  Directory: C:\\Users\\johnis\n" +
      "  Session:   session_670b0345-ec99-4395-ac2a-c78fc4ca3291\n" +
      "  Model:     K2.7 Code\n" +
      "  Version:   0.14.3";
    expect(banner.match(KIMI_SESSION_ID_RE)?.[1]).toBe(
      "session_670b0345-ec99-4395-ac2a-c78fc4ca3291"
    );
  });

  it("does not match Hermes's timestamp-form session id", () => {
    expect(
      "Session: 20260531_133925_98d9fc".match(KIMI_SESSION_ID_RE)
    ).toBeNull();
  });
});
