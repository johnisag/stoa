/**
 * Locks the orchestration MCP-config writer (lib/mcp-config.ts) that the
 * "Enable orchestration" New Session option drives: it must write the `stoa`
 * server with THIS session's CONDUCTOR_SESSION_ID, merge non-destructively, and
 * git-exclude the generated .mcp.json so it never pollutes the user's repo.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import path from "path";
import { ensureMcpConfig, hasMcpConfig } from "@/lib/mcp-config";

describe("ensureMcpConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "stoa-mcp-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the stoa server with this session's CONDUCTOR_SESSION_ID", () => {
    ensureMcpConfig(dir, "session-abc");
    const cfg = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf-8"));
    expect(cfg.mcpServers.stoa).toBeTruthy();
    expect(cfg.mcpServers.stoa.command).toBe("npx");
    expect(cfg.mcpServers.stoa.args).toContain("tsx");
    expect(cfg.mcpServers.stoa.env.CONDUCTOR_SESSION_ID).toBe("session-abc");
    expect(hasMcpConfig(dir)).toBe(true);
  });

  it("merges non-destructively — preserves a user's existing server", () => {
    writeFileSync(
      path.join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { github: { command: "gh-mcp", args: [] } },
      })
    );
    ensureMcpConfig(dir, "s1");
    const cfg = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf-8"));
    expect(cfg.mcpServers.github).toBeTruthy(); // preserved
    expect(cfg.mcpServers.stoa).toBeTruthy(); // added
  });

  it("recovers from a malformed array .mcp.json instead of dropping stoa", () => {
    // A top-level JSON array survives JSON.parse but JSON.stringify([]) === "[]"
    // would silently drop the stoa server — start fresh instead.
    writeFileSync(path.join(dir, ".mcp.json"), "[]");
    ensureMcpConfig(dir, "s1");
    const cfg = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf-8"));
    expect(Array.isArray(cfg)).toBe(false);
    expect(cfg.mcpServers.stoa).toBeTruthy();
    expect(hasMcpConfig(dir)).toBe(true);
  });

  it("git-excludes .mcp.json locally so it doesn't pollute the repo", () => {
    // Make the temp dir a git repo so the exclude path resolves.
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    ensureMcpConfig(dir, "s1");
    const exclude = readFileSync(
      path.join(dir, ".git", "info", "exclude"),
      "utf-8"
    );
    expect(exclude.split(/\r?\n/)).toContain(".mcp.json");
  });

  it("does not double-add the exclude entry on repeat enables", () => {
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    ensureMcpConfig(dir, "s1");
    ensureMcpConfig(dir, "s1");
    const exclude = readFileSync(
      path.join(dir, ".git", "info", "exclude"),
      "utf-8"
    );
    const count = exclude
      .split(/\r?\n/)
      .filter((l) => l.trim() === ".mcp.json").length;
    expect(count).toBe(1);
  });

  it("is a no-op-safe write on a non-git dir (no throw, config still written)", () => {
    expect(() => ensureMcpConfig(dir, "s1")).not.toThrow();
    expect(existsSync(path.join(dir, ".mcp.json"))).toBe(true);
  });
});
