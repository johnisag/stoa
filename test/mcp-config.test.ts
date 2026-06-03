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
import {
  ensureMcpConfig,
  hasMcpConfig,
  buildCodexOrchestrationArgs,
  buildHermesRegisterArgs,
  writeConductorMarker,
  removeConductorMarker,
  planHermesRegistration,
} from "@/lib/mcp-config";
import { CONDUCTOR_MARKER_FILE } from "@/lib/conductor-marker";

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

describe("buildCodexOrchestrationArgs — Codex conductor `-c` flags", () => {
  it("emits a complete inline stoa server with this session's id", () => {
    const args = buildCodexOrchestrationArgs("sess-123");
    // Tokens come in (-c, key=value) pairs.
    expect(args.length % 2).toBe(0);
    for (let i = 0; i < args.length; i += 2) expect(args[i]).toBe("-c");

    const kv = args.filter((_, i) => i % 2 === 1);
    expect(kv).toContain("mcp_servers.stoa.command='npx'");
    expect(kv.some((s) => /^mcp_servers\.stoa\.args=\['tsx',/.test(s))).toBe(
      true
    );
    expect(kv).toContain(
      "mcp_servers.stoa.env.CONDUCTOR_SESSION_ID='sess-123'"
    );
    // Points npx tsx at the orchestration server entrypoint.
    expect(args.join(" ")).toContain("orchestration-server.ts");
  });

  it("uses TOML single-quoted literals (keeps Windows backslashes intact)", () => {
    const args = buildCodexOrchestrationArgs("s1");
    const argsToken = args.find((s) => s.startsWith("mcp_servers.stoa.args="))!;
    // Single-quoted (literal) — never double-quoted, which would mangle `\m`.
    expect(argsToken).not.toContain('"');
    expect(argsToken).toContain("'tsx'");
  });

  it("escapes a value containing a single quote as a double-quoted TOML string (F6)", () => {
    // A single-quoted literal can't hold a `'`, so a checkout under …/o'brien/…
    // (or any quoted value) must emit a valid double-quoted basic string instead
    // of broken TOML that makes Codex drop the stoa server.
    const args = buildCodexOrchestrationArgs("ses'x");
    const idToken = args.find((s) =>
      s.startsWith("mcp_servers.stoa.env.CONDUCTOR_SESSION_ID=")
    )!;
    expect(idToken).toBe('mcp_servers.stoa.env.CONDUCTOR_SESSION_ID="ses\'x"');
  });
});

describe("planHermesRegistration — stale-path self-correction (F3)", () => {
  const cur = "/abs/stoa/mcp/orchestration-server.ts";

  it("skips when listed AND recorded at the current path", () => {
    expect(planHermesRegistration(true, cur, cur)).toEqual({
      skip: true,
      removeFirst: false,
    });
  });

  it("re-points (remove-first) when listed at a STALE path", () => {
    expect(planHermesRegistration(true, "/old/path/server.ts", cur)).toEqual({
      skip: false,
      removeFirst: true,
    });
  });

  it("re-registers (remove-first) when listed but the path is unknown", () => {
    expect(planHermesRegistration(true, null, cur)).toEqual({
      skip: false,
      removeFirst: true,
    });
  });

  it("adds fresh (no remove) when not listed at all", () => {
    expect(planHermesRegistration(false, null, cur)).toEqual({
      skip: false,
      removeFirst: false,
    });
  });
});

describe("removeConductorMarker (F5)", () => {
  it("deletes the .stoa-conductor marker so a reused dir can't inherit a dead id", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "stoa-cond-"));
    try {
      writeConductorMarker(dir, "sess-1");
      expect(existsSync(path.join(dir, CONDUCTOR_MARKER_FILE))).toBe(true);
      removeConductorMarker(dir);
      expect(existsSync(path.join(dir, CONDUCTOR_MARKER_FILE))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op (no throw) when there's no marker", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "stoa-cond-"));
    try {
      expect(() => removeConductorMarker(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Hermes conductor wiring", () => {
  it("buildHermesRegisterArgs registers the stoa stdio server (command/args only)", () => {
    const args = buildHermesRegisterArgs("/abs/orchestration-server.ts");
    expect(args).toEqual([
      "mcp",
      "add",
      "stoa",
      "--command",
      "npx",
      "--args",
      "tsx",
      "/abs/orchestration-server.ts",
    ]);
    // No per-session env baked into the global registration — the id rides the
    // marker file, so multiple conductors don't clobber each other.
    expect(args).not.toContain("--env");
  });

  it("writeConductorMarker drops the session id in a .stoa-conductor file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "stoa-cond-"));
    try {
      writeConductorMarker(dir, "sess-77");
      const marker = readFileSync(
        path.join(dir, CONDUCTOR_MARKER_FILE),
        "utf-8"
      );
      expect(marker.trim()).toBe("sess-77");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("git-excludes the marker so it never pollutes the repo", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "stoa-cond-"));
    try {
      execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
      writeConductorMarker(dir, "s1");
      const exclude = readFileSync(
        path.join(dir, ".git", "info", "exclude"),
        "utf-8"
      );
      expect(exclude.split(/\r?\n/)).toContain(CONDUCTOR_MARKER_FILE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
