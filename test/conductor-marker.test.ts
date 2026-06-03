/**
 * Locks the conductor session-id resolution the orchestration MCP server uses.
 * Claude/Codex deliver the id via env; Hermes (which strips env vars from MCP
 * children) via a `.stoa-conductor` marker file in the server's cwd. Pure
 * fs/string logic — runs on the 3-OS matrix.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  resolveConductorSessionId,
  CONDUCTOR_MARKER_FILE,
} from "@/lib/conductor-marker";

describe("resolveConductorSessionId", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "stoa-marker-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prefers CONDUCTOR_SESSION_ID from env (even if a marker exists)", () => {
    writeFileSync(path.join(dir, CONDUCTOR_MARKER_FILE), "from-marker\n");
    expect(
      resolveConductorSessionId(dir, { CONDUCTOR_SESSION_ID: "from-env" })
    ).toBe("from-env");
  });

  it("falls back to the cwd marker file when env is unset (Hermes path)", () => {
    writeFileSync(path.join(dir, CONDUCTOR_MARKER_FILE), "sess-xyz\n");
    expect(resolveConductorSessionId(dir, {})).toBe("sess-xyz");
  });

  it("trims whitespace from the marker", () => {
    writeFileSync(path.join(dir, CONDUCTOR_MARKER_FILE), "  sess-trim \r\n");
    expect(resolveConductorSessionId(dir, {})).toBe("sess-trim");
  });

  it("returns empty string when neither env nor marker is present", () => {
    expect(resolveConductorSessionId(dir, {})).toBe("");
  });

  it("treats a blank env value as unset and uses the marker", () => {
    writeFileSync(path.join(dir, CONDUCTOR_MARKER_FILE), "marker-wins\n");
    expect(
      resolveConductorSessionId(dir, { CONDUCTOR_SESSION_ID: "   " })
    ).toBe("marker-wins");
  });
});
