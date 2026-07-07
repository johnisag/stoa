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
import { execFileSync, spawnSync } from "child_process";
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
  _mcpServerCommandForTests,
} from "@/lib/mcp-config";
import { CONDUCTOR_MARKER_FILE } from "@/lib/conductor-marker";
import { isWindows, resolveBinary } from "@/lib/platform";

function expectedWindowsNpxCliPath() {
  if (!isWindows) return null;
  const candidates = new Set<string>();
  const npx = resolveBinary("npx");
  if (npx) {
    candidates.add(
      path.join(path.dirname(npx), "node_modules", "npm", "bin", "npx-cli.js")
    );
  }
  if (process.execPath) {
    candidates.add(
      path.join(
        path.dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        "npx-cli.js"
      )
    );
  }
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    candidates.add(path.join(path.dirname(npmExecPath), "npx-cli.js"));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function expectedMcpCommand() {
  return isWindows && expectedWindowsNpxCliPath()
    ? resolveBinary("node") || process.execPath || "node"
    : resolveBinary("npx") || "npx";
}

function expectedMcpArgsPrefix() {
  const npxCli = expectedWindowsNpxCliPath();
  return isWindows && npxCli ? [npxCli] : [];
}

function expectedTomlString(v: string) {
  if (!v.includes("'")) return `'${v}'`;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

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
    expect(cfg.mcpServers.stoa.command).toBe(expectedMcpCommand());
    expect(
      cfg.mcpServers.stoa.args.slice(0, expectedMcpArgsPrefix().length)
    ).toEqual(expectedMcpArgsPrefix());
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

  it("recovers when mcpServers itself is malformed", () => {
    for (const malformed of [[], "oops", null]) {
      writeFileSync(
        path.join(dir, ".mcp.json"),
        JSON.stringify({ mcpServers: malformed, other: true })
      );

      ensureMcpConfig(dir, "s1");
      const cfg = JSON.parse(
        readFileSync(path.join(dir, ".mcp.json"), "utf-8")
      );

      expect(cfg.other).toBe(true);
      expect(Array.isArray(cfg.mcpServers)).toBe(false);
      expect(cfg.mcpServers.stoa).toBeTruthy();
    }
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

describe("mcpServerCommand", () => {
  it("uses node + npx-cli.js on Windows so npx.cmd never reparses paths", () => {
    const result = _mcpServerCommandForTests({
      onWindows: true,
      execPath: "C:/Program Files/nodejs/node.exe",
      npmExecPath: "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js",
      resolveBin: (name) =>
        name === "node"
          ? "C:/Program Files/nodejs/node.exe"
          : name === "npx"
            ? "C:/Program Files/nodejs/npx.cmd"
            : null,
      exists: (candidate) =>
        candidate.replace(/\\/g, "/").endsWith("npm/bin/npx-cli.js"),
    });

    expect(result.command).toBe("C:/Program Files/nodejs/node.exe");
    expect(result.argsPrefix.map((p) => p.replace(/\\/g, "/"))).toEqual([
      "C:/Program Files/nodejs/node_modules/npm/bin/npx-cli.js",
    ]);
  });

  it("refuses to fall back to npx.cmd on Windows when npx-cli.js is missing", () => {
    expect(() =>
      _mcpServerCommandForTests({
        onWindows: true,
        execPath: "C:\\Program Files\\nodejs\\node.exe",
        npmExecPath: undefined,
        resolveBin: (name) =>
          name === "node"
            ? "C:\\Program Files\\nodejs\\node.exe"
            : name === "npx"
              ? "C:\\Program Files\\nodejs\\npx.cmd"
              : null,
        exists: () => false,
      })
    ).toThrow(
      "Unable to locate npm npx-cli.js on Windows; cannot safely configure Stoa MCP server"
    );
  });
});

describe("buildCodexOrchestrationArgs — Codex conductor `-c` flags", () => {
  it("emits a complete inline stoa server with this session's id", () => {
    const args = buildCodexOrchestrationArgs("sess-123");
    // Tokens come in (-c, key=value) pairs.
    expect(args.length % 2).toBe(0);
    for (let i = 0; i < args.length; i += 2) expect(args[i]).toBe("-c");

    const kv = args.filter((_, i) => i % 2 === 1);
    const commandToken = kv.find((s) =>
      s.startsWith("mcp_servers.stoa.command=")
    );
    expect(commandToken).toBeTruthy();
    expect(commandToken).toContain(expectedMcpCommand());
    const argsToken = kv.find((s) => s.startsWith("mcp_servers.stoa.args="))!;
    for (const prefix of expectedMcpArgsPrefix()) {
      expect(argsToken).toContain(expectedTomlString(prefix));
    }
    if (isWindows) {
      // Codex starts MCP servers with a direct child-process spawn. On Windows,
      // use node+npx-cli.js so cmd.exe never reparses the server path.
      expect(path.basename(expectedMcpCommand()).toLowerCase()).not.toBe(
        "cmd.exe"
      );
      const probe = spawnSync(
        expectedMcpCommand(),
        [...expectedMcpArgsPrefix(), "--version"],
        { encoding: "utf8" }
      );
      expect(probe.error).toBeUndefined();
      expect(probe.status).toBe(0);
    }
    expect(argsToken).toContain("'tsx'");
    expect(kv).toContain(
      "mcp_servers.stoa.env.CONDUCTOR_SESSION_ID='sess-123'"
    );
    // Points npx tsx at the orchestration server entrypoint.
    expect(args.join(" ")).toContain("orchestration-server.ts");
  });

  it("uses TOML-safe literals for argv values (keeps Windows backslashes intact)", () => {
    const args = buildCodexOrchestrationArgs("s1");
    const argsToken = args.find((s) => s.startsWith("mcp_servers.stoa.args="))!;
    expect(argsToken).toContain(expectedTomlString("tsx"));
    for (const prefix of expectedMcpArgsPrefix()) {
      expect(argsToken).toContain(expectedTomlString(prefix));
    }
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
  const cur = JSON.stringify({
    schemaVersion: 2,
    serverPath: "/abs/stoa/mcp/orchestration-server.ts",
    command: "npx",
    args: ["tsx", "/abs/stoa/mcp/orchestration-server.ts"],
  });

  it("skips when listed AND recorded at the current registration identity", () => {
    expect(planHermesRegistration(true, cur, cur)).toEqual({
      skip: true,
      removeFirst: false,
    });
  });

  it("re-points (remove-first) when listed at a STALE identity", () => {
    expect(
      planHermesRegistration(true, JSON.stringify({ old: true }), cur)
    ).toEqual({
      skip: false,
      removeFirst: true,
    });
  });

  it("treats the old path-only marker format as stale", () => {
    expect(
      planHermesRegistration(true, "/abs/stoa/mcp/orchestration-server.ts", cur)
    ).toEqual({ skip: false, removeFirst: true });
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

describe("removeConductorMarker (F5 + ownership check)", () => {
  it("deletes the marker when the id matches (the conductor's own delete)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "stoa-cond-"));
    try {
      writeConductorMarker(dir, "sess-1");
      expect(existsSync(path.join(dir, CONDUCTOR_MARKER_FILE))).toBe(true);
      removeConductorMarker(dir, "sess-1");
      expect(existsSync(path.join(dir, CONDUCTOR_MARKER_FILE))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT delete a live conductor's marker when a SIBLING session is deleted", () => {
    // Conductor (orchestration on, no worktree) wrote the marker into the shared
    // project dir; deleting a plain sibling session in that dir must leave it.
    const dir = mkdtempSync(path.join(tmpdir(), "stoa-cond-"));
    try {
      writeConductorMarker(dir, "conductor-id");
      removeConductorMarker(dir, "some-other-sibling-id");
      expect(existsSync(path.join(dir, CONDUCTOR_MARKER_FILE))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op (no throw) when there's no marker", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "stoa-cond-"));
    try {
      expect(() => removeConductorMarker(dir, "x")).not.toThrow();
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
      expectedMcpCommand(),
      "--args",
      ...expectedMcpArgsPrefix(),
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
