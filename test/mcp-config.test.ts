/**
 * Locks the provider-native orchestration MCP-config writers that the "Enable
 * orchestration" option drives: each must write `stoa` with THIS session's id,
 * merge non-destructively, and locally git-exclude generated project files.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
} from "fs";
import { execFileSync, spawnSync } from "child_process";
import { tmpdir } from "os";
import path from "path";
import { pathToFileURL } from "url";
import {
  ensureMcpConfig,
  ensureKiloMcpConfig,
  ensureKimiMcpConfig,
  ensureProviderMcpConfig,
  KILO_MCP_CONFIG_PATH,
  KIMI_MCP_CONFIG_PATH,
  hasMcpConfig,
  buildCodexOrchestrationArgs,
  buildHermesRegisterArgs,
  writeConductorMarker,
  removeConductorMarker,
  planHermesRegistration,
  _parseRegisteredHermesIdentityMarkerForTests,
  _mcpServerCommandForTests,
  _findStoaInstallRootForTests,
  _ensureHermesMcpRegisteredForTests,
  McpConfigSetupError,
} from "@/lib/mcp-config";
import { CONDUCTOR_MARKER_FILE } from "@/lib/conductor-marker";

const EXPECTED_TSX_CLI = path.join(
  process.cwd(),
  "node_modules",
  "tsx",
  "dist",
  "cli.mjs"
);

function expectedMcpCommand() {
  return process.execPath;
}

function expectedMcpArgsPrefix() {
  return [EXPECTED_TSX_CLI];
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

  it("writes an owned generic stoa server using Stoa's pinned tsx", () => {
    ensureMcpConfig(dir, "session-abc");
    const cfg = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf-8"));
    expect(cfg.mcpServers.stoa).toBeTruthy();
    expect(cfg.mcpServers.stoa.command).toBe(expectedMcpCommand());
    expect(
      cfg.mcpServers.stoa.args.slice(0, expectedMcpArgsPrefix().length)
    ).toEqual(expectedMcpArgsPrefix());
    expect(path.basename(cfg.mcpServers.stoa.args[0])).toBe("cli.mjs");
    expect(cfg.mcpServers.stoa.args).not.toContain("tsx");
    expect(cfg.mcpServers.stoa.env.CONDUCTOR_SESSION_ID).toBe(
      "${STOA_CONDUCTOR_SESSION_ID}"
    );
    expect(cfg.mcpServers.stoa.env.STOA_MCP_CONFIG_OWNER).toBe(
      "stoa-managed-v1"
    );
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

  it("leaves malformed Claude configs byte-for-byte intact", () => {
    for (const malformed of [
      "[]",
      "{ definitely-not-json",
      '{ "mcpServers": null, "other": true }',
    ]) {
      const configPath = path.join(dir, ".mcp.json");
      writeFileSync(configPath, malformed);
      expect(() => ensureMcpConfig(dir, "s1")).toThrow(
        /Cannot update Claude MCP config/
      );
      expect(readFileSync(configPath, "utf-8")).toBe(malformed);
    }
  });

  it("preserves a user-owned stoa entry instead of replacing it", () => {
    const configPath = path.join(dir, ".mcp.json");
    const original = JSON.stringify({
      mcpServers: { stoa: { command: "user-server", args: ["--stdio"] } },
    });
    writeFileSync(configPath, original);
    expect(() => ensureMcpConfig(dir, "s1")).toThrow(/user-owned stoa/);
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  it("adopts only the exact prior Stoa schema bound to a durable local session", () => {
    const configPath = path.join(dir, ".mcp.json");
    const legacySessionId = "11111111-1111-4111-8111-111111111111";
    const serverPath = path.join(
      process.cwd(),
      "mcp",
      "orchestration-server.ts"
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          stoa: {
            command: "npx",
            args: ["tsx", serverPath],
            env: {
              STOA_URL: "http://localhost:3011",
              CONDUCTOR_SESSION_ID: legacySessionId,
            },
          },
        },
      })
    );
    const observed: Array<[string, string]> = [];

    ensureMcpConfig(dir, "new-session", {
      isLegacyClaudeSessionOwned: (sessionId, workingDirectory) => {
        observed.push([sessionId, workingDirectory]);
        return sessionId === legacySessionId && workingDirectory === dir;
      },
    });

    expect(observed).toEqual([[legacySessionId, dir]]);
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.mcpServers.stoa.env).toMatchObject({
      STOA_MCP_CONFIG_OWNER: "stoa-managed-v1",
      CONDUCTOR_SESSION_ID: "${STOA_CONDUCTOR_SESSION_ID}",
    });
  });

  it("keeps an exact legacy-looking entry when no durable session owns it", () => {
    const configPath = path.join(dir, ".mcp.json");
    const original = JSON.stringify({
      mcpServers: {
        stoa: {
          command: "npx",
          args: [
            "tsx",
            path.join(process.cwd(), "mcp", "orchestration-server.ts"),
          ],
          env: {
            STOA_URL: "http://localhost:3011",
            CONDUCTOR_SESSION_ID: "22222222-2222-4222-8222-222222222222",
          },
        },
      },
    });
    writeFileSync(configPath, original);

    expect(() =>
      ensureMcpConfig(dir, "new-session", {
        isLegacyClaudeSessionOwned: () => false,
      })
    ).toThrow(/user-owned stoa/);
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  it("stays byte-identical for two conductor sessions sharing one cwd", () => {
    ensureMcpConfig(dir, "session-one");
    const first = readFileSync(path.join(dir, ".mcp.json"), "utf-8");
    ensureMcpConfig(dir, "session-two");
    expect(readFileSync(path.join(dir, ".mcp.json"), "utf-8")).toBe(first);
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

  it("rejects a final config-file symlink without modifying its target", () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), "stoa-mcp-outside-"));
    const outside = path.join(outsideDir, "outside-config.json");
    const original = JSON.stringify({ owner: "outside" });
    writeFileSync(outside, original);
    try {
      try {
        symlinkSync(outside, path.join(dir, ".mcp.json"), "file");
      } catch (error) {
        // Some Windows CI workers do not grant file-symlink privilege. The
        // junction-parent test below still exercises Windows reparse points.
        if (
          process.platform === "win32" &&
          (error as NodeJS.ErrnoException).code === "EPERM"
        ) {
          return;
        }
        throw error;
      }

      expect(() => ensureMcpConfig(dir, "s1")).toThrow(/symlink or junction/);
      expect(readFileSync(outside, "utf-8")).toBe(original);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("provider-native project MCP configs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "stoa-provider-mcp-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes Kilo's supported .kilo/kilo.json local-server shape", () => {
    ensureKiloMcpConfig(dir, "kilo-session");

    const configPath = path.join(dir, ".kilo", "kilo.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.mcp.stoa).toMatchObject({
      type: "local",
      enabled: true,
      environment: {
        CONDUCTOR_SESSION_ID: "{env:STOA_CONDUCTOR_SESSION_ID}",
        STOA_MCP_CONFIG_OWNER: "stoa-managed-v1",
      },
    });
    expect(config.mcp.stoa.command[0]).toBe(expectedMcpCommand());
    expect(
      config.mcp.stoa.command.slice(1, 1 + expectedMcpArgsPrefix().length)
    ).toEqual(expectedMcpArgsPrefix());
    expect(config.mcp.stoa.command).not.toContain("tsx");
    expect(config.mcp.stoa.command.at(-1)).toMatch(/orchestration-server\.ts$/);
    expect(config.mcp.stoa.environment.STOA_URL).toBeTruthy();
  });

  it("writes Kimi's required .kimi-code/mcp.json stdio shape", () => {
    ensureKimiMcpConfig(dir, "kimi-session");

    const configPath = path.join(dir, ".kimi-code", "mcp.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.mcpServers.stoa.transport).toBe("stdio");
    expect(config.mcpServers.stoa.enabled).toBe(true);
    expect(config.mcpServers.stoa.command).toBe(expectedMcpCommand());
    expect(
      config.mcpServers.stoa.args.slice(0, expectedMcpArgsPrefix().length)
    ).toEqual(expectedMcpArgsPrefix());
    expect(config.mcpServers.stoa.args).not.toContain("tsx");
    expect(config.mcpServers.stoa.args.at(-1)).toMatch(
      /orchestration-server\.ts$/
    );
    expect(config.mcpServers.stoa.env).toMatchObject({
      STOA_URL: expect.any(String),
      CONDUCTOR_SESSION_ID: "${STOA_CONDUCTOR_SESSION_ID}",
      STOA_MCP_CONFIG_OWNER: "stoa-managed-v1",
    });
  });

  it("rejects provider config directories redirected outside the project", () => {
    const cases = [
      {
        directory: ".kilo",
        file: "kilo.json",
        write: ensureKiloMcpConfig,
      },
      {
        directory: ".kimi-code",
        file: "mcp.json",
        write: ensureKimiMcpConfig,
      },
    ];

    for (const testCase of cases) {
      const project = path.join(dir, `project-${testCase.directory.slice(1)}`);
      const outside = mkdtempSync(path.join(tmpdir(), "stoa-mcp-outside-"));
      mkdirSync(project);
      try {
        symlinkSync(
          outside,
          path.join(project, testCase.directory),
          process.platform === "win32" ? "junction" : "dir"
        );

        expect(() => testCase.write(project, "session")).toThrow(
          /symlink or junction/
        );
        expect(existsSync(path.join(outside, testCase.file))).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    }
  });

  it("preserves unrelated Kilo keys and is generic across two sessions", () => {
    const configDir = path.join(dir, ".kilo");
    const configPath = path.join(configDir, "kilo.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        model: "user/default",
        mcp: {
          github: {
            type: "remote",
            url: "https://example.test/mcp",
            enabled: false,
          },
          stoa: {
            type: "local",
            command: ["old-command"],
            timeout: 12_345,
            environment: {
              USER_SETTING: "preserved",
              CONDUCTOR_SESSION_ID: "{env:STOA_CONDUCTOR_SESSION_ID}",
              STOA_MCP_CONFIG_OWNER: "stoa-managed-v1",
            },
          },
        },
      })
    );

    ensureKiloMcpConfig(dir, "session-one");
    const once = readFileSync(configPath, "utf-8");
    ensureKiloMcpConfig(dir, "session-two");
    expect(readFileSync(configPath, "utf-8")).toBe(once);

    const config = JSON.parse(once);
    expect(config.model).toBe("user/default");
    expect(config.mcp.github).toEqual({
      type: "remote",
      url: "https://example.test/mcp",
      enabled: false,
    });
    expect(config.mcp.stoa.timeout).toBe(12_345);
    expect(config.mcp.stoa.environment.USER_SETTING).toBe("preserved");
    expect(config.mcp.stoa.command).not.toEqual(["old-command"]);
  });

  it("preserves unrelated Kimi keys and is generic across two sessions", () => {
    const configDir = path.join(dir, ".kimi-code");
    const configPath = path.join(configDir, "mcp.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        metadata: { owner: "user" },
        mcpServers: {
          github: { command: "github-mcp", args: ["--stdio"] },
          stoa: {
            transport: "http",
            url: "https://old.example.test/mcp",
            headers: { Authorization: "old" },
            bearerTokenEnvVar: "OLD_TOKEN",
            command: "old-command",
            args: [],
            cwd: "custom-cwd",
            startupTimeoutMs: 12_345,
            env: {
              USER_SETTING: "preserved",
              CONDUCTOR_SESSION_ID: "${STOA_CONDUCTOR_SESSION_ID}",
              STOA_MCP_CONFIG_OWNER: "stoa-managed-v1",
            },
            enabled: false,
          },
        },
      })
    );

    ensureKimiMcpConfig(dir, "session-one");
    const once = readFileSync(configPath, "utf-8");
    ensureKimiMcpConfig(dir, "session-two");
    expect(readFileSync(configPath, "utf-8")).toBe(once);

    const config = JSON.parse(once);
    expect(config.metadata).toEqual({ owner: "user" });
    expect(config.mcpServers.github).toEqual({
      command: "github-mcp",
      args: ["--stdio"],
    });
    expect(config.mcpServers.stoa.cwd).toBe("custom-cwd");
    expect(config.mcpServers.stoa.startupTimeoutMs).toBe(12_345);
    expect(config.mcpServers.stoa.env.USER_SETTING).toBe("preserved");
    expect(config.mcpServers.stoa.transport).toBe("stdio");
    expect(config.mcpServers.stoa.enabled).toBe(true);
    expect(config.mcpServers.stoa).not.toHaveProperty("url");
    expect(config.mcpServers.stoa).not.toHaveProperty("headers");
    expect(config.mcpServers.stoa).not.toHaveProperty("bearerTokenEnvVar");
    expect(config.mcpServers.stoa.command).not.toBe("old-command");
  });

  it("leaves malformed Kilo and Kimi configs byte-for-byte intact", () => {
    const cases = [
      {
        dirName: ".kilo",
        fileName: "kilo.json",
        malformed: '{ "mcp": [1, 2] }',
        write: ensureKiloMcpConfig,
      },
      {
        dirName: ".kilo",
        fileName: "kilo.json",
        malformed: "{ definitely-not-json",
        write: ensureKiloMcpConfig,
      },
      {
        dirName: ".kimi-code",
        fileName: "mcp.json",
        malformed: "{ definitely-not-json",
        write: ensureKimiMcpConfig,
      },
      {
        dirName: ".kimi-code",
        fileName: "mcp.json",
        malformed: '{ "mcpServers": { "stoa": false } }',
        write: ensureKimiMcpConfig,
      },
    ];

    for (const testCase of cases) {
      const configDir = path.join(dir, testCase.dirName);
      const configPath = path.join(configDir, testCase.fileName);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, testCase.malformed);

      expect(() => testCase.write(dir, "session")).toThrow(
        /Cannot update (Kilo|Kimi) MCP config/
      );
      expect(readFileSync(configPath, "utf-8")).toBe(testCase.malformed);
    }
  });

  it("preserves user-owned Kilo and Kimi stoa entries", () => {
    const cases = [
      {
        relativePath: KILO_MCP_CONFIG_PATH,
        config: { mcp: { stoa: { command: ["user-kilo"] } } },
        write: ensureKiloMcpConfig,
      },
      {
        relativePath: KIMI_MCP_CONFIG_PATH,
        config: {
          mcpServers: { stoa: { command: "user-kimi", args: [] } },
        },
        write: ensureKimiMcpConfig,
      },
    ];
    for (const testCase of cases) {
      const configPath = path.join(dir, testCase.relativePath);
      mkdirSync(path.dirname(configPath), { recursive: true });
      const original = JSON.stringify(testCase.config);
      writeFileSync(configPath, original);
      expect(() => testCase.write(dir, "session")).toThrow(/user-owned stoa/);
      expect(readFileSync(configPath, "utf-8")).toBe(original);
      rmSync(configPath);
    }
  });

  it("coexists with Kilo JSONC without rewriting comments", () => {
    const rootJsoncPath = path.join(dir, "kilo.jsonc");
    const nestedDir = path.join(dir, ".kilo");
    const nestedJsoncPath = path.join(nestedDir, "kilo.jsonc");
    const rootJsonc = '{\n  // user comment\n  "model": "root/model"\n}\n';
    const nestedJsonc = '{\n  // another comment\n  "theme": "dark"\n}\n';
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(rootJsoncPath, rootJsonc);
    writeFileSync(nestedJsoncPath, nestedJsonc);

    ensureKiloMcpConfig(dir, "session");

    expect(readFileSync(rootJsoncPath, "utf-8")).toBe(rootJsonc);
    expect(readFileSync(nestedJsoncPath, "utf-8")).toBe(nestedJsonc);
    expect(existsSync(path.join(nestedDir, "kilo.json"))).toBe(true);
  });

  it("git-excludes the exact generated provider paths once", () => {
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });

    ensureKiloMcpConfig(dir, "session");
    ensureKiloMcpConfig(dir, "session");
    ensureKimiMcpConfig(dir, "session");
    ensureKimiMcpConfig(dir, "session");

    const lines = readFileSync(
      path.join(dir, ".git", "info", "exclude"),
      "utf-8"
    )
      .split(/\r?\n/)
      .filter(Boolean);
    expect(lines.filter((line) => line === KILO_MCP_CONFIG_PATH)).toHaveLength(
      1
    );
    expect(lines.filter((line) => line === KIMI_MCP_CONFIG_PATH)).toHaveLength(
      1
    );
  });

  it("dispatches only project-config providers", () => {
    ensureProviderMcpConfig("kilo", dir, "kilo-session");
    ensureProviderMcpConfig("kimi", dir, "kimi-session");
    expect(existsSync(path.join(dir, ".kilo", "kilo.json"))).toBe(true);
    expect(existsSync(path.join(dir, ".kimi-code", "mcp.json"))).toBe(true);
    expect(() =>
      ensureProviderMcpConfig("codex", dir, "codex-session")
    ).toThrow(/does not use a project MCP config file/);
  });
});

describe("mcpServerCommand", () => {
  it("derives the Stoa root from the module tree and ships tsx at runtime", () => {
    expect(_findStoaInstallRootForTests(path.join(process.cwd(), "lib"))).toBe(
      process.cwd()
    );
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf-8")
    );
    expect(manifest.dependencies.tsx).toBeTruthy();
    expect(manifest.devDependencies.tsx).toBeUndefined();
  });

  it("uses absolute node + pinned tsx argv and runs without npx/network", () => {
    const result = _mcpServerCommandForTests({});
    expect(result).toEqual({
      command: process.execPath,
      argsPrefix: [EXPECTED_TSX_CLI],
    });
    expect(path.isAbsolute(result.command)).toBe(true);
    expect(result.argsPrefix.every(path.isAbsolute)).toBe(true);
    expect(result.command.toLowerCase()).not.toContain("npx");
    const probe = spawnSync(
      result.command,
      [...result.argsPrefix, "--version"],
      {
        encoding: "utf8",
      }
    );
    expect(probe.error).toBeUndefined();
    expect(probe.status).toBe(0);
  });

  it("ignores a malicious project-local tsx package", () => {
    const project = mkdtempSync(path.join(tmpdir(), "stoa-malicious-tsx-"));
    try {
      const maliciousDir = path.join(project, "node_modules", "tsx", "dist");
      mkdirSync(maliciousDir, { recursive: true });
      writeFileSync(
        path.join(maliciousDir, "cli.mjs"),
        "throw new Error('project tsx executed')"
      );
      const moduleUrl = pathToFileURL(
        path.join(process.cwd(), "lib", "mcp-config.ts")
      ).href;
      const probe = spawnSync(
        process.execPath,
        [
          EXPECTED_TSX_CLI,
          "--eval",
          `import { _mcpServerCommandForTests as get } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(get({})));`,
        ],
        { cwd: project, encoding: "utf8" }
      );
      expect(probe.error).toBeUndefined();
      expect(probe.status, probe.stderr).toBe(0);
      expect(JSON.parse(probe.stdout.trim())).toEqual({
        command: process.execPath,
        argsPrefix: [EXPECTED_TSX_CLI],
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("fails closed when the pinned absolute tsx path is unavailable", () => {
    const missing = path.resolve("definitely-missing", "tsx", "cli.mjs");
    expect(() =>
      _mcpServerCommandForTests({
        execPath: process.execPath,
        tsxCliPath: missing,
        exists: () => false,
      })
    ).toThrow(/pinned tsx CLI is missing/);
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
    const probe = spawnSync(
      expectedMcpCommand(),
      [...expectedMcpArgsPrefix(), "--version"],
      { encoding: "utf8" }
    );
    expect(probe.error).toBeUndefined();
    expect(probe.status).toBe(0);
    expect(argsToken).not.toMatch(/(?:\[|,)'tsx'(?:,|\])/);
    expect(kv).toContain(
      "mcp_servers.stoa.env.CONDUCTOR_SESSION_ID='sess-123'"
    );
    // Points Stoa's pinned tsx CLI at the orchestration server entrypoint.
    expect(args.join(" ")).toContain("orchestration-server.ts");
  });

  it("uses TOML-safe literals for argv values (keeps Windows backslashes intact)", () => {
    const args = buildCodexOrchestrationArgs("s1");
    const argsToken = args.find((s) => s.startsWith("mcp_servers.stoa.args="))!;
    expect(argsToken).toContain(expectedTomlString(EXPECTED_TSX_CLI));
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

describe("planHermesRegistration — ownership-safe global registration", () => {
  const cur = JSON.stringify({
    schemaVersion: 3,
    serverPath: "/abs/stoa/mcp/orchestration-server.ts",
    command: "/abs/node",
    args: ["/abs/tsx/cli.mjs", "/abs/stoa/mcp/orchestration-server.ts"],
  });

  it("skips when listed AND recorded at the current registration identity", () => {
    expect(planHermesRegistration(true, cur, cur)).toEqual({
      skip: true,
      replaceExisting: false,
      conflict: false,
    });
  });

  it("adopts the exact raw schema-v2 marker written by the prior Stoa release", () => {
    const legacy = JSON.stringify({
      schemaVersion: 2,
      serverPath: "/abs/stoa/mcp/orchestration-server.ts",
      command: "npx",
      args: ["tsx", "/abs/stoa/mcp/orchestration-server.ts"],
    });
    const parsed = _parseRegisteredHermesIdentityMarkerForTests(`${legacy}\n`);

    expect(parsed).toBe(legacy);
    expect(planHermesRegistration(true, parsed, cur)).toEqual({
      skip: false,
      replaceExisting: true,
      conflict: false,
    });
  });

  it("does not adopt a schema-v2 marker for another installation", () => {
    const foreign = JSON.stringify({
      schemaVersion: 2,
      serverPath: "/other/stoa/mcp/orchestration-server.ts",
      command: "npx",
      args: ["tsx", "/other/stoa/mcp/orchestration-server.ts"],
    });
    expect(planHermesRegistration(true, foreign, cur)).toEqual({
      skip: false,
      replaceExisting: false,
      conflict: true,
    });
  });

  it("fails closed without removing a listed server at a stale identity", () => {
    expect(
      planHermesRegistration(true, JSON.stringify({ old: true }), cur)
    ).toEqual({
      skip: false,
      replaceExisting: false,
      conflict: true,
    });
  });

  it("treats the old path-only marker format as stale", () => {
    expect(
      planHermesRegistration(true, "/abs/stoa/mcp/orchestration-server.ts", cur)
    ).toEqual({ skip: false, replaceExisting: false, conflict: true });
  });

  it("preserves a user-owned global stoa entry when no marker proves ownership", () => {
    expect(planHermesRegistration(true, null, cur)).toEqual({
      skip: false,
      replaceExisting: false,
      conflict: true,
    });
  });

  it("adds fresh (no remove) when not listed at all", () => {
    expect(planHermesRegistration(false, null, cur)).toEqual({
      skip: false,
      replaceExisting: false,
      conflict: false,
    });
  });
});

describe("ensureHermesMcpRegistered — verified, non-destructive setup", () => {
  const serverPath = path.join(process.cwd(), "mcp", "orchestration-server.ts");

  it("throws when Hermes add fails and never records ownership", () => {
    const writeIdentity = vi.fn();
    const exec = vi.fn((_executable: string, args: string[]) => {
      if (args[1] === "list") return "No MCP servers configured";
      throw new Error("add failed");
    });

    expect(() =>
      _ensureHermesMcpRegisteredForTests({
        exec,
        resolveExecutable: () => "hermes",
        serverPath,
        readIdentity: () => null,
        writeIdentity,
      })
    ).toThrow(McpConfigSetupError);
    expect(writeIdentity).not.toHaveBeenCalled();
  });

  it("fails closed when the post-add list is stale or missing stoa", () => {
    const writeIdentity = vi.fn();
    let listCalls = 0;
    const exec = vi.fn((_executable: string, args: string[]) => {
      if (args[1] === "list") {
        listCalls++;
        return "other-server /tools/stoa enabled";
      }
      return "Saved 'stoa' to /home/test/.hermes/config.yaml (7/7 tools enabled)";
    });

    expect(() =>
      _ensureHermesMcpRegisteredForTests({
        exec,
        resolveExecutable: () => "hermes",
        serverPath,
        readIdentity: () => null,
        writeIdentity,
      })
    ).toThrow(/not visible during verification/);
    expect(listCalls).toBe(2);
    expect(writeIdentity).not.toHaveBeenCalled();
  });

  it("rejects a saved Hermes server that discovered zero tools", () => {
    const writeIdentity = vi.fn();
    let listCalls = 0;
    const exec = vi.fn((_executable: string, args: string[]) => {
      if (args[1] === "list") {
        listCalls++;
        return "No MCP servers configured";
      }
      return "Saved 'stoa' to config";
    });

    expect(() =>
      _ensureHermesMcpRegisteredForTests({
        exec,
        resolveExecutable: () => "hermes",
        serverPath,
        readIdentity: () => null,
        writeIdentity,
      })
    ).toThrow(/at least one discovered orchestration tool was enabled/);
    expect(listCalls).toBe(1);
    expect(writeIdentity).not.toHaveBeenCalled();
  });

  it("never removes a legacy entry before an overwrite attempt that fails", () => {
    const legacyIdentity = JSON.stringify({
      schemaVersion: 2,
      serverPath,
      command: "npx",
      args: ["tsx", serverPath],
    });
    const writeIdentity = vi.fn();
    const exec = vi.fn(
      (_executable: string, args: string[], _options: { input?: string }) => {
        if (args[1] === "list") return "stoa stdio all enabled";
        if (args[1] === "add") throw new Error("discovery failed");
        throw new Error(`unexpected Hermes command: ${args.join(" ")}`);
      }
    );

    expect(() =>
      _ensureHermesMcpRegisteredForTests({
        exec,
        resolveExecutable: () => "hermes",
        serverPath,
        readIdentity: () => legacyIdentity,
        writeIdentity,
      })
    ).toThrow(McpConfigSetupError);
    expect(exec.mock.calls.some(([, args]) => args[1] === "remove")).toBe(
      false
    );
    expect(
      exec.mock.calls.find(([, args]) => args[1] === "add")?.[2].input
    ).toBe("y\n\n");
    expect(writeIdentity).not.toHaveBeenCalled();
  });

  it("records ownership only after add and post-list verification", () => {
    const writeIdentity = vi.fn();
    let listCalls = 0;
    const exec = vi.fn((_executable: string, args: string[]) => {
      if (args[1] === "list") {
        listCalls++;
        return listCalls === 1
          ? "No MCP servers configured"
          : "stoa stdio all enabled";
      }
      return "Saved 'stoa' to /home/test/.hermes/config.yaml (7/7 tools enabled)";
    });

    expect(
      _ensureHermesMcpRegisteredForTests({
        exec,
        resolveExecutable: () => "hermes",
        serverPath,
        readIdentity: () => null,
        writeIdentity,
      })
    ).toBe(true);
    expect(writeIdentity).toHaveBeenCalledTimes(1);
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
  it("registers pinned stdio argv with a per-process identity mapping", () => {
    const args = buildHermesRegisterArgs("/abs/orchestration-server.ts");
    expect(args).toEqual([
      "mcp",
      "add",
      "stoa",
      "--command",
      expectedMcpCommand(),
      "--env",
      "CONDUCTOR_SESSION_ID=${STOA_CONDUCTOR_SESSION_ID}",
      "--args",
      ...expectedMcpArgsPrefix(),
      "/abs/orchestration-server.ts",
    ]);
    expect(args).not.toContain("tsx");
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
