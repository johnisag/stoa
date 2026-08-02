/**
 * MCP Config Auto-Generation
 *
 * Writes provider-native configuration so conductor sessions automatically
 * pick up orchestration tools. Shared configs use a generic environment
 * placeholder; the launch path supplies each process's own session identity.
 */

import {
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  rmSync,
  renameSync,
  statSync,
  lstatSync,
  realpathSync,
} from "fs";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { resolveBinary } from "./platform";
import {
  CONDUCTOR_MARKER_FILE,
  parseConductorMarker,
} from "./conductor-marker";
import type { ProviderId } from "./providers/registry";

const STOA_URL = process.env.STOA_URL || "http://localhost:3011";

export const CLAUDE_MCP_CONFIG_PATH = ".mcp.json";
// Kilo also accepts root-level and JSONC variants. Its config-directory loader
// merges `.kilo/kilo.jsonc` followed by `.kilo/kilo.json`, so this deterministic
// JSON target takes precedence for `mcp.stoa` without rewriting user comments.
export const KILO_MCP_CONFIG_PATH = ".kilo/kilo.json";
export const KIMI_MCP_CONFIG_PATH = ".kimi-code/mcp.json";

interface McpServerCommand {
  command: string;
  argsPrefix: string[];
}

interface McpServerCommandDeps {
  exists?: (path: string) => boolean;
  execPath?: string;
  tsxCliPath?: string;
}

interface InstallRootDeps {
  exists?: (candidate: string) => boolean;
  readFile?: (candidate: string) => string;
}

function findStoaInstallRoot(
  startDirectory: string,
  deps: InstallRootDeps = {}
): string {
  const exists = deps.exists ?? existsSync;
  const readFile =
    deps.readFile ?? ((candidate) => readFileSync(candidate, "utf-8"));
  let current = path.resolve(startDirectory);
  for (;;) {
    const manifestPath = path.join(current, "package.json");
    if (exists(manifestPath)) {
      try {
        const manifest = JSON.parse(readFile(manifestPath)) as unknown;
        if (
          isPlainObjectRecord(manifest) &&
          manifest.name === "@johnisag/stoa"
        ) {
          return current;
        }
      } catch {
        // Keep walking: generated bundle directories can contain other manifests.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("Cannot locate the Stoa installation root from this module");
}

export function _findStoaInstallRootForTests(
  startDirectory: string,
  deps: InstallRootDeps = {}
): string {
  return findStoaInstallRoot(startDirectory, deps);
}

// Resolve from this module, never from process.cwd(): MCP sessions deliberately
// run in user-controlled projects, and direct server launches need not inherit
// Stoa's cwd. The explicit runtime dependency path is offline and unambiguous.
const STOA_INSTALL_ROOT = findStoaInstallRoot(
  path.dirname(fileURLToPath(import.meta.url))
);
// Resolve with Node's algorithm anchored at Stoa's own manifest. This supports
// npm's normal hoisting layout while remaining independent of the MCP child's
// project cwd. `tsx` is a runtime dependency, so absence is a broken install.
const STOA_REQUIRE = createRequire(
  path.join(STOA_INSTALL_ROOT, "package.json")
);
const PINNED_TSX_CLI_PATH = STOA_REQUIRE.resolve("tsx/cli");

function mcpServerCommand(deps: McpServerCommandDeps = {}): McpServerCommand {
  const exists = deps.exists ?? existsSync;
  const execPath = deps.execPath ?? process.execPath;
  const tsxCliPath = deps.tsxCliPath ?? PINNED_TSX_CLI_PATH;
  if (!path.isAbsolute(execPath) || !path.isAbsolute(tsxCliPath)) {
    throw new Error(
      "Cannot safely configure Stoa MCP server: node and tsx paths must be absolute"
    );
  }
  if (!exists(tsxCliPath)) {
    throw new Error(
      `Cannot safely configure Stoa MCP server: pinned tsx CLI is missing at ${tsxCliPath}`
    );
  }
  return { command: execPath, argsPrefix: [tsxCliPath] };
}

export function _mcpServerCommandForTests(
  deps: McpServerCommandDeps
): McpServerCommand {
  return mcpServerCommand(deps);
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

const STOA_MCP_OWNER_KEY = "STOA_MCP_CONFIG_OWNER";
const STOA_MCP_OWNER_VALUE = "stoa-managed-v1";
const CONDUCTOR_PROCESS_ENV = "STOA_CONDUCTOR_SESSION_ID";
const CONDUCTOR_ENV_PLACEHOLDER = `\${${CONDUCTOR_PROCESS_ENV}}`;
const KILO_CONDUCTOR_ENV_PLACEHOLDER = `{env:${CONDUCTOR_PROCESS_ENV}}`;

export interface McpConfigOwnershipDeps {
  /** Prove a legacy Stoa-generated Claude entry is bound to a durable session. */
  isLegacyClaudeSessionOwned?: (
    sessionId: string,
    workingDirectory: string
  ) => boolean;
}

/**
 * Stoa never replaces a provider config entry it cannot prove it owns. Routes
 * distinguish this from transient setup errors and return 409 without launching
 * an agent against an ambiguous user-owned server.
 */
export class McpConfigConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigConflictError";
  }
}

/** A transient provider/CLI failure that leaves orchestration unconfigured. */
export class McpConfigSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigSetupError";
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * Resolve a project-owned config path without following repository-controlled
 * symlink/junction parents. The selected project root itself may be an alias,
 * so it is canonicalized once; every child component is then required to be a
 * real directory below that canonical root. This also makes subsequent writes
 * use the canonical parent instead of traversing the repository alias again.
 */
function resolveProjectConfigPath(
  workingDirectory: string,
  relativePath: string,
  createParents: boolean
): string {
  const normalized = path.normalize(relativePath);
  if (
    path.isAbsolute(relativePath) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new McpConfigConflictError(
      `Cannot configure orchestration outside the selected project: ${relativePath}`
    );
  }

  let root: string;
  try {
    root = realpathSync.native(path.resolve(workingDirectory));
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new McpConfigConflictError(
      `Cannot configure orchestration: project directory is unavailable: ${workingDirectory}`
    );
  }

  const relativeParent = path.dirname(normalized);
  const components =
    relativeParent === "." ? [] : relativeParent.split(path.sep);
  let parent = root;
  for (let index = 0; index < components.length; index++) {
    const component = components[index];
    const candidate = path.join(parent, component);
    if (!existsSync(candidate)) {
      if (!createParents) {
        parent = path.join(parent, ...components.slice(index));
        break;
      }
      mkdirSync(candidate);
    }

    let entry;
    try {
      entry = lstatSync(candidate);
    } catch {
      throw new McpConfigConflictError(
        `Cannot configure orchestration: project config directory changed while it was being checked: ${candidate}`
      );
    }
    // Node reports Windows directory junctions as symbolic links too.
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new McpConfigConflictError(
        `Cannot configure orchestration through a symlink or junction: ${candidate}`
      );
    }
    const canonical = realpathSync.native(candidate);
    if (!isPathWithin(root, canonical)) {
      throw new McpConfigConflictError(
        `Cannot configure orchestration outside the selected project: ${candidate}`
      );
    }
    parent = canonical;
  }

  const configPath = path.join(parent, path.basename(normalized));
  if (existsSync(configPath)) {
    const entry = lstatSync(configPath);
    if (entry.isSymbolicLink()) {
      throw new McpConfigConflictError(
        `Cannot configure orchestration through a symlink or junction: ${configPath}`
      );
    }
    if (!entry.isFile()) {
      throw new McpConfigConflictError(
        `Cannot configure orchestration through a non-file config path: ${configPath}`
      );
    }
    const canonical = realpathSync.native(configPath);
    if (!isPathWithin(root, canonical)) {
      throw new McpConfigConflictError(
        `Cannot configure orchestration outside the selected project: ${configPath}`
      );
    }
  }
  return configPath;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (!isPlainObjectRecord(left) || !isPlainObjectRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && jsonValuesEqual(left[key], right[key])
    )
  );
}

function priorManagedEntry(
  entry: Record<string, unknown>,
  environmentKey: "env" | "environment"
): Record<string, unknown> {
  const environment = entry[environmentKey];
  if (!isPlainObjectRecord(environment)) return entry;
  return {
    ...entry,
    [environmentKey]: {
      ...environment,
      [STOA_MCP_OWNER_KEY]: STOA_MCP_OWNER_VALUE,
    },
  };
}

/** A repository-controlled owner value is not authority. Existing entries are
 * reusable only when the whole record is already the harmless strict record
 * Stoa would write (or that same record with the previous marker). */
function assertStoaEntryMayBeUpdated(
  existing: Record<string, unknown>,
  managed: Record<string, unknown>,
  environmentKey: "env" | "environment",
  providerName: string,
  configPath: string
): void {
  if (
    !jsonValuesEqual(existing, managed) &&
    !jsonValuesEqual(existing, priorManagedEntry(managed, environmentKey))
  ) {
    throw new McpConfigConflictError(
      `Cannot configure ${providerName} orchestration: ${configPath} already contains a user-owned stoa MCP server`
    );
  }
}

function objectHasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    [...expected].sort().every((key, index) => keys[index] === key)
  );
}

/**
 * Recognize only the exact project entry emitted by the immediately preceding
 * Stoa release. The durable session callback is still required before adoption;
 * matching this shape alone never grants ownership.
 */
function legacyClaudeConductorSessionId(
  entry: Record<string, unknown>,
  environment: Record<string, unknown>,
  orchestrationServerPath: string
): string | null {
  if (!objectHasOnlyKeys(entry, ["command", "args", "env"])) return null;
  if (!objectHasOnlyKeys(environment, ["STOA_URL", "CONDUCTOR_SESSION_ID"])) {
    return null;
  }
  if (
    typeof entry.command !== "string" ||
    entry.command.trim() === "" ||
    environment.STOA_URL !== STOA_URL ||
    typeof environment.CONDUCTOR_SESSION_ID !== "string" ||
    environment.CONDUCTOR_SESSION_ID.trim() === "" ||
    !Array.isArray(entry.args) ||
    !entry.args.every((value) => typeof value === "string")
  ) {
    return null;
  }
  const args = entry.args as string[];
  const validPosixArgs =
    args.length === 2 &&
    args[0] === "tsx" &&
    args[1] === orchestrationServerPath;
  const validWindowsArgs =
    args.length === 3 &&
    path.basename(args[0]).toLowerCase() === "npx-cli.js" &&
    args[1] === "tsx" &&
    args[2] === orchestrationServerPath;
  return validPosixArgs || validWindowsArgs
    ? environment.CONDUCTOR_SESSION_ID
    : null;
}

function hermesRegistrationIdentity(serverPath: string): string {
  const mcp = mcpServerCommand();
  return JSON.stringify({
    // Schema 4 means the entry passed positive Hermes discovery (N/N tools,
    // N > 0) and a fresh exact-name list before this identity was recorded.
    // Schema 3 was written by older Stoa builds before that proof existed, so
    // it must migrate through `mcp add` instead of taking the skip path.
    schemaVersion: 4,
    serverPath,
    command: mcp.command,
    args: [...mcp.argsPrefix, serverPath],
    env: { CONDUCTOR_SESSION_ID: CONDUCTOR_ENV_PLACEHOLDER },
  });
}

/** Absolute path to the orchestration MCP server entrypoint (server cwd-based). */
function getOrchestrationServerPath(): string {
  return path.join(STOA_INSTALL_ROOT, "mcp", "orchestration-server.ts");
}

function readJsonObjectForUpdate(
  configPath: string,
  providerName: string
): Record<string, unknown> {
  if (!existsSync(configPath)) return {};

  const source = readFileSync(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new McpConfigConflictError(
      `Cannot update ${providerName} MCP config: ${configPath} is not valid JSON`
    );
  }
  if (!isPlainObjectRecord(parsed)) {
    throw new McpConfigConflictError(
      `Cannot update ${providerName} MCP config: ${configPath} must contain a JSON object`
    );
  }
  return parsed;
}

function readServerMapForUpdate(
  config: Record<string, unknown>,
  key: "mcp" | "mcpServers",
  configPath: string,
  providerName: string
): Record<string, unknown> {
  const current = config[key];
  if (current === undefined) return {};
  if (!isPlainObjectRecord(current)) {
    throw new McpConfigConflictError(
      `Cannot update ${providerName} MCP config: ${configPath}.${key} must be a JSON object`
    );
  }
  return current;
}

function readNestedObjectForUpdate(
  owner: Record<string, unknown>,
  key: string,
  configPath: string,
  providerName: string,
  jsonPath: string
): Record<string, unknown> {
  const current = owner[key];
  if (current === undefined) return {};
  if (!isPlainObjectRecord(current)) {
    throw new McpConfigConflictError(
      `Cannot update ${providerName} MCP config: ${configPath}.${jsonPath} must be a JSON object`
    );
  }
  return current;
}

function writeJsonAtomically(
  configPath: string,
  config: Record<string, unknown>
): void {
  writeTextAtomically(configPath, JSON.stringify(config, null, 2) + "\n");
}

function writeTextAtomically(configPath: string, source: string): void {
  const tempPath = `${configPath}.stoa-${process.pid}-${randomUUID()}.tmp`;
  const existing = existsSync(configPath) ? lstatSync(configPath) : null;
  if (existing?.isSymbolicLink()) {
    throw new McpConfigConflictError(
      `Cannot configure orchestration through a symlink or junction: ${configPath}`
    );
  }
  const mode = existing?.mode;
  try {
    writeFileSync(tempPath, source, {
      encoding: "utf-8",
      flag: "wx",
      mode,
    });
    renameSync(tempPath, configPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function writeProjectConfig(
  workingDirectory: string,
  relativePath: string,
  config: Record<string, unknown>
): void {
  const configPath = resolveProjectConfigPath(
    workingDirectory,
    relativePath,
    true
  );
  writeJsonAtomically(configPath, config);
  ensureGitExcluded(workingDirectory, relativePath);
}

/**
 * Write or update .mcp.json in the working directory with orchestration server config
 */
export function ensureMcpConfig(
  workingDirectory: string,
  _sessionId: string,
  ownership: McpConfigOwnershipDeps = {}
): void {
  const configPath = resolveProjectConfigPath(
    workingDirectory,
    CLAUDE_MCP_CONFIG_PATH,
    false
  );
  const orchestrationServerPath = getOrchestrationServerPath();
  const config = readJsonObjectForUpdate(configPath, "Claude");
  const servers = readServerMapForUpdate(
    config,
    "mcpServers",
    configPath,
    "Claude"
  );
  const hasStoa = Object.prototype.hasOwnProperty.call(servers, "stoa");
  const existingStoa = readNestedObjectForUpdate(
    servers,
    "stoa",
    configPath,
    "Claude",
    "mcpServers.stoa"
  );
  const existingEnv = readNestedObjectForUpdate(
    existingStoa,
    "env",
    configPath,
    "Claude",
    "mcpServers.stoa.env"
  );
  const mcp = mcpServerCommand();
  const managedStoa = {
    command: mcp.command,
    args: [...mcp.argsPrefix, orchestrationServerPath],
    env: {
      STOA_URL,
      CONDUCTOR_SESSION_ID: CONDUCTOR_ENV_PLACEHOLDER,
    },
  };
  if (hasStoa) {
    const legacySessionId = legacyClaudeConductorSessionId(
      existingStoa,
      existingEnv,
      orchestrationServerPath
    );
    const legacyOwned =
      legacySessionId != null &&
      ownership.isLegacyClaudeSessionOwned?.(
        legacySessionId,
        workingDirectory
      ) === true;
    if (!legacyOwned) {
      assertStoaEntryMayBeUpdated(
        existingStoa,
        managedStoa,
        "env",
        "Claude",
        configPath
      );
    }
  }
  config.mcpServers = {
    ...servers,
    stoa: managedStoa,
  };
  writeProjectConfig(workingDirectory, CLAUDE_MCP_CONFIG_PATH, config);
}

/**
 * Write Kilo's project-local MCP entry. Stoa deliberately targets
 * `.kilo/kilo.json`, one of Kilo's documented project config paths, and never
 * rewrites JSONC files because serializing them as JSON would destroy comments.
 * Existing JSON must be structurally usable; malformed user data is left intact
 * and reported to the caller instead of being reset.
 */
export function ensureKiloMcpConfig(
  workingDirectory: string,
  _sessionId: string
): void {
  const configPath = resolveProjectConfigPath(
    workingDirectory,
    KILO_MCP_CONFIG_PATH,
    false
  );
  const config = readJsonObjectForUpdate(configPath, "Kilo");
  const servers = readServerMapForUpdate(config, "mcp", configPath, "Kilo");
  const existingStoa = readNestedObjectForUpdate(
    servers,
    "stoa",
    configPath,
    "Kilo",
    "mcp.stoa"
  );
  const mcp = mcpServerCommand();
  const managedStoa = {
    type: "local",
    command: [mcp.command, ...mcp.argsPrefix, getOrchestrationServerPath()],
    environment: {
      STOA_URL,
      CONDUCTOR_SESSION_ID: KILO_CONDUCTOR_ENV_PLACEHOLDER,
    },
    enabled: true,
  };
  if (Object.prototype.hasOwnProperty.call(servers, "stoa")) {
    assertStoaEntryMayBeUpdated(
      existingStoa,
      managedStoa,
      "environment",
      "Kilo",
      configPath
    );
  }

  config.mcp = {
    ...servers,
    stoa: managedStoa,
  };

  writeProjectConfig(workingDirectory, KILO_MCP_CONFIG_PATH, config);
}

/**
 * Write Kimi Code's project-local `.kimi-code/mcp.json` entry. Existing JSON is
 * merged by key; malformed data is never overwritten.
 */
export function ensureKimiMcpConfig(
  workingDirectory: string,
  _sessionId: string
): void {
  const configPath = resolveProjectConfigPath(
    workingDirectory,
    KIMI_MCP_CONFIG_PATH,
    false
  );
  const config = readJsonObjectForUpdate(configPath, "Kimi");
  const servers = readServerMapForUpdate(
    config,
    "mcpServers",
    configPath,
    "Kimi"
  );
  const existingStoa = readNestedObjectForUpdate(
    servers,
    "stoa",
    configPath,
    "Kimi",
    "mcpServers.stoa"
  );
  const mcp = mcpServerCommand();
  const managedStoa = {
    transport: "stdio",
    command: mcp.command,
    args: [...mcp.argsPrefix, getOrchestrationServerPath()],
    env: {
      STOA_URL,
      CONDUCTOR_SESSION_ID: CONDUCTOR_ENV_PLACEHOLDER,
    },
    enabled: true,
  };
  if (Object.prototype.hasOwnProperty.call(servers, "stoa")) {
    assertStoaEntryMayBeUpdated(
      existingStoa,
      managedStoa,
      "env",
      "Kimi",
      configPath
    );
  }

  config.mcpServers = {
    ...servers,
    stoa: managedStoa,
  };

  writeProjectConfig(workingDirectory, KIMI_MCP_CONFIG_PATH, config);
}

/** Dispatch project-file orchestration to the provider's native config format. */
export function ensureProviderMcpConfig(
  providerId: ProviderId,
  workingDirectory: string,
  sessionId: string,
  ownership: McpConfigOwnershipDeps = {}
): void {
  switch (providerId) {
    case "claude":
      ensureMcpConfig(workingDirectory, sessionId, ownership);
      return;
    case "kilo":
      ensureKiloMcpConfig(workingDirectory, sessionId);
      return;
    case "kimi":
      ensureKimiMcpConfig(workingDirectory, sessionId);
      return;
    default:
      throw new Error(
        `Provider ${providerId} does not use a project MCP config file`
      );
  }
}

/**
 * Add `entry` to the repo's LOCAL git exclude (`.git/info/exclude`) — untracked,
 * so it never shows in the user's `git status` and never touches their tracked
 * `.gitignore`. Resolves the common git dir so it works inside git worktrees
 * too. Best-effort: a non-git dir or missing `git` is silently skipped (the file
 * simply isn't excluded — no error).
 */
function ensureGitExcluded(workingDirectory: string, entry: string): void {
  try {
    const commonDir = execFileSync(
      "git",
      [
        "-C",
        workingDirectory,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }
    ).trim();
    if (!commonDir) return;

    const excludePath = path.join(commonDir, "info", "exclude");
    const existing = existsSync(excludePath)
      ? readFileSync(excludePath, "utf-8")
      : "";
    if (existing.split(/\r?\n/).some((line) => line.trim() === entry)) return;

    mkdirSync(path.dirname(excludePath), { recursive: true });
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(excludePath, existing + sep + entry + "\n");
  } catch {
    // Not a git repo / git unavailable — nothing to exclude.
  }
}

/**
 * Build the Codex launch flags that wire the stoa MCP server into a Codex
 * CONDUCTOR session.
 *
 * Codex has no project-local config file — only global `~/.codex/config.toml`
 * or per-launch `-c key=value` overrides — so we inline a COMPLETE server
 * definition with `-c mcp_servers.stoa.*`. This is session-scoped (nothing is
 * written to the user's global config, unlike `codex mcp add`) and bakes THIS
 * conductor's CONDUCTOR_SESSION_ID directly into the server's env.
 *
 * Values are parsed as TOML; single-quoted literals keep Windows backslashes in
 * the absolute server path intact (a double-quoted TOML string would treat `\m`
 * as an invalid escape). Returned as clean argv tokens — the pty path passes
 * them through verbatim and the tmux path shell-quotes them.
 */
export function buildCodexOrchestrationArgs(sessionId: string): string[] {
  const serverPath = getOrchestrationServerPath();
  const mcp = mcpServerCommand();
  const set = (kv: string): string[] => ["-c", kv];
  return [
    ...set(`mcp_servers.stoa.command=${tomlString(mcp.command)}`),
    ...set(
      `mcp_servers.stoa.args=[${[...mcp.argsPrefix, serverPath]
        .map(tomlString)
        .join(",")}]`
    ),
    ...set(`mcp_servers.stoa.env.STOA_URL=${tomlString(STOA_URL)}`),
    ...set(
      `mcp_servers.stoa.env.CONDUCTOR_SESSION_ID=${tomlString(sessionId)}`
    ),
  ];
}

/**
 * Render a string as a TOML value. Prefers a single-quoted LITERAL (keeps
 * Windows backslashes in a path intact — `'C:\x'` parses as-is). A literal
 * can't contain a single quote, so a value with one (e.g. a checkout under
 * `…/o'brien/…`) falls back to a double-quoted basic string with backslashes
 * and quotes escaped — which would otherwise emit invalid TOML and make Codex
 * launch without the stoa server.
 */
function tomlString(v: string): string {
  if (!v.includes("'")) return `'${v}'`;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Write the conductor marker file (`.stoa-conductor`, containing the session id)
 * into the working dir, and git-exclude it. Retained only as a compatibility
 * fallback for older Hermes registrations; new launches use the per-process
 * STOA_CONDUCTOR_SESSION_ID mapping and never write this shared marker.
 */
export function writeConductorMarker(
  workingDirectory: string,
  sessionId: string
): void {
  if (parseConductorMarker(sessionId) !== sessionId) {
    throw new McpConfigConflictError(
      "Cannot configure Hermes orchestration: invalid conductor session id"
    );
  }
  const markerPath = resolveProjectConfigPath(
    workingDirectory,
    CONDUCTOR_MARKER_FILE,
    true
  );
  writeTextAtomically(markerPath, sessionId + "\n");
  ensureGitExcluded(workingDirectory, CONDUCTOR_MARKER_FILE);
}

/**
 * Remove the conductor marker on session delete — but ONLY this session's own
 * marker. Without cleanup the `.stoa-conductor` file outlives its session, so a
 * later plain Hermes session in the SAME dir (Hermes registers stoa globally)
 * inherits the dead conductor's id. But a conductor with orchestration + NO
 * worktree writes the marker into the SHARED project dir, so deleting a sibling
 * session in that dir must NOT wipe the live conductor's marker — hence the
 * content==sessionId ownership check. Best-effort.
 */
export function removeConductorMarker(
  workingDirectory: string,
  sessionId: string
): void {
  try {
    const markerPath = resolveProjectConfigPath(
      workingDirectory,
      CONDUCTOR_MARKER_FILE,
      false
    );
    if (!existsSync(markerPath)) return;
    if (parseConductorMarker(readFileSync(markerPath, "utf-8")) === sessionId)
      rmSync(markerPath, { force: true });
  } catch {
    // Best-effort — a leftover marker is only consulted by Hermes conductors.
  }
}

/** argv for `hermes mcp add`. The global entry maps the parent agent's
 * process-local identity into the stdio MCP child; no session id is persisted. */
export function buildHermesRegisterArgs(serverPath: string): string[] {
  const mcp = mcpServerCommand();
  return [
    "mcp",
    "add",
    "stoa",
    "--command",
    mcp.command,
    "--env",
    `CONDUCTOR_SESSION_ID=${CONDUCTOR_ENV_PLACEHOLDER}`,
    "--args",
    ...mcp.argsPrefix,
    serverPath,
  ];
}

/** Where we record the exact Hermes registration last written. `hermes mcp
 * list` only shows the name, not enough detail to establish ownership itself. */
const HERMES_PATH_MARKER = path.join(
  os.homedir(),
  ".stoa",
  "hermes-stoa-server-path"
);

export function _parseRegisteredHermesIdentityMarkerForTests(
  source: string
): string | null {
  try {
    const marker = JSON.parse(source) as unknown;
    if (
      isPlainObjectRecord(marker) &&
      marker.schemaVersion === 1 &&
      marker.owner === "stoa" &&
      typeof marker.identity === "string"
    ) {
      return marker.identity;
    }
    // The immediately preceding release wrote the registration identity JSON
    // itself. Return only that exact schema for planHermesRegistration to bind
    // to this installation's current server path before it can be adopted.
    if (
      isPlainObjectRecord(marker) &&
      marker.schemaVersion === 2 &&
      objectHasOnlyKeys(marker, [
        "schemaVersion",
        "serverPath",
        "command",
        "args",
      ])
    ) {
      return source.trim();
    }
  } catch {
    // ignore
  }
  return null;
}

function readRegisteredHermesIdentity(): string | null {
  try {
    if (!existsSync(HERMES_PATH_MARKER)) return null;
    return _parseRegisteredHermesIdentityMarkerForTests(
      readFileSync(HERMES_PATH_MARKER, "utf-8")
    );
  } catch {
    // ignore
  }
  return null;
}

function writeRegisteredHermesIdentity(identity: string): void {
  mkdirSync(path.dirname(HERMES_PATH_MARKER), { recursive: true });
  writeJsonAtomically(HERMES_PATH_MARKER, {
    schemaVersion: 1,
    owner: "stoa",
    identity,
  });
}

function legacyHermesIdentityMatchesCurrent(
  recordedIdentity: string,
  currentIdentity: string
): boolean {
  try {
    const legacy = JSON.parse(recordedIdentity) as unknown;
    const current = JSON.parse(currentIdentity) as unknown;
    if (
      !isPlainObjectRecord(legacy) ||
      !isPlainObjectRecord(current) ||
      current.schemaVersion !== 4 ||
      !objectHasOnlyKeys(current, [
        "schemaVersion",
        "serverPath",
        "command",
        "args",
        "env",
      ])
    ) {
      return false;
    }

    // Schema 3 proves ownership of the same Stoa stdio entry, but not that the
    // old add discovered any tools. Recognize only the exact old Stoa shape so
    // it can be replaced add-first and earn a schema-4 verified marker.
    if (legacy.schemaVersion === 3) {
      return (
        objectHasOnlyKeys(legacy, [
          "schemaVersion",
          "serverPath",
          "command",
          "args",
          "env",
        ]) &&
        typeof legacy.serverPath === "string" &&
        legacy.serverPath === current.serverPath &&
        typeof legacy.command === "string" &&
        path.isAbsolute(legacy.command) &&
        Array.isArray(legacy.args) &&
        Array.isArray(current.args) &&
        legacy.args.every((value) => typeof value === "string") &&
        JSON.stringify(legacy.args) === JSON.stringify(current.args) &&
        isPlainObjectRecord(legacy.env) &&
        isPlainObjectRecord(current.env) &&
        objectHasOnlyKeys(legacy.env, ["CONDUCTOR_SESSION_ID"]) &&
        JSON.stringify(legacy.env) === JSON.stringify(current.env)
      );
    }

    if (
      legacy.schemaVersion !== 2 ||
      !objectHasOnlyKeys(legacy, [
        "schemaVersion",
        "serverPath",
        "command",
        "args",
      ]) ||
      typeof legacy.serverPath !== "string" ||
      legacy.serverPath !== current.serverPath ||
      typeof legacy.command !== "string" ||
      legacy.command.trim() === "" ||
      !Array.isArray(legacy.args) ||
      !legacy.args.every((value) => typeof value === "string")
    ) {
      return false;
    }
    const args = legacy.args as string[];
    return (
      (args.length === 2 &&
        args[0] === "tsx" &&
        args[1] === legacy.serverPath) ||
      (args.length === 3 &&
        path.basename(args[0]).toLowerCase() === "npx-cli.js" &&
        args[1] === "tsx" &&
        args[2] === legacy.serverPath)
    );
  } catch {
    return false;
  }
}

/**
 * Decide what to do about the global `stoa` Hermes registration (pure, so it's
 * unit-testable). Skip only when it is listed and the structured Stoa marker
 * matches exactly. A listed mismatch is ambiguous and must be preserved.
 */
export function planHermesRegistration(
  stoaListed: boolean,
  recordedIdentity: string | null,
  currentIdentity: string
): { skip: boolean; replaceExisting: boolean; conflict: boolean } {
  if (stoaListed && recordedIdentity === currentIdentity)
    return { skip: true, replaceExisting: false, conflict: false };
  if (
    stoaListed &&
    recordedIdentity != null &&
    legacyHermesIdentityMatchesCurrent(recordedIdentity, currentIdentity)
  ) {
    return { skip: false, replaceExisting: true, conflict: false };
  }
  if (stoaListed)
    return { skip: false, replaceExisting: false, conflict: true };
  return { skip: false, replaceExisting: false, conflict: false };
}

interface HermesExecOptions {
  encoding: "utf-8";
  input?: string;
  stdio: ["ignore" | "pipe", "pipe", "ignore"];
  timeout: number;
  killSignal: "SIGKILL";
  windowsHide: true;
}

interface HermesRegistrationDeps {
  exec?: (
    executable: string,
    args: string[],
    options: HermesExecOptions
  ) => string;
  resolveExecutable?: () => string;
  serverPath?: string;
  readIdentity?: () => string | null;
  writeIdentity?: (identity: string) => void;
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function hermesListsStoa(value: string): boolean {
  return stripAnsi(value)
    .split(/\r?\n/)
    .some((line) => /^\s*stoa(?:\s|$)/.test(line));
}

function hermesReportedSavedAllTools(value: string): boolean {
  return stripAnsi(value)
    .split(/\r?\n/)
    .some((line) => {
      const match = line.match(
        /\bSaved\s+['"]stoa['"]\s+to\s+.+\s+\((\d+)\/(\d+)\s+tools enabled\)\s*$/i
      );
      if (!match) return false;
      const enabled = Number(match[1]);
      const discovered = Number(match[2]);
      return (
        Number.isSafeInteger(enabled) &&
        Number.isSafeInteger(discovered) &&
        discovered > 0 &&
        enabled === discovered
      );
    });
}

function hermesSetupError(error: unknown): McpConfigSetupError {
  const detail =
    error instanceof Error && error.message.trim()
      ? error.message.trim()
      : "Hermes MCP registration failed";
  return new McpConfigSetupError(
    `Cannot configure Hermes orchestration: ${detail}`
  );
}

/**
 * Register the stoa MCP server in Hermes' GLOBAL config (command/args only, no
 * per-session data) so a Hermes conductor exposes spawn_worker. Idempotent when
 * the exact Stoa-owned identity is already registered and fail-closed when a
 * listed `stoa` entry is not proven to be ours. `hermes mcp add` is interactive
 * ("Enable all N tools?") and discovery-first (it spawns the server to list
 * tools), so we auto-confirm via stdin. Every shell-out is bounded by a timeout
 * + SIGKILL so a slow/hung MCP discovery can't block the session-create request.
 * CLI/discovery failures throw and callers must not mark a session as a
 * conductor until this returns. Legacy migration approves Hermes' overwrite
 * prompt but never removes the prior entry before discovery and save complete.
 */
function ensureHermesMcpRegisteredWithDeps(
  deps: HermesRegistrationDeps = {}
): true {
  try {
    const exec =
      deps.exec ??
      ((executable, args, options) =>
        execFileSync(executable, args, options) as string);
    const hermes =
      deps.resolveExecutable?.() ?? resolveBinary("hermes") ?? "hermes";
    const serverPath = deps.serverPath ?? getOrchestrationServerPath();
    const identity = hermesRegistrationIdentity(serverPath);
    const list = exec(hermes, ["mcp", "list"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    const stoaListed = hermesListsStoa(list);
    const plan = planHermesRegistration(
      stoaListed,
      (deps.readIdentity ?? readRegisteredHermesIdentity)(),
      identity
    );
    if (plan.skip) return true;
    if (plan.conflict) {
      throw new McpConfigConflictError(
        "Cannot configure Hermes orchestration: global MCP server 'stoa' exists but is not proven to be owned by this Stoa installation"
      );
    }
    const addOutput = exec(hermes, buildHermesRegisterArgs(serverPath), {
      input: plan.replaceExisting ? "y\n\n" : "\n",
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 20000,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    if (!hermesReportedSavedAllTools(addOutput)) {
      throw new McpConfigSetupError(
        "Cannot configure Hermes orchestration: Hermes did not confirm that at least one discovered orchestration tool was enabled"
      );
    }
    const verifiedList = exec(hermes, ["mcp", "list"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    if (!hermesListsStoa(verifiedList)) {
      throw new McpConfigSetupError(
        "Cannot configure Hermes orchestration: the saved stoa MCP server was not visible during verification"
      );
    }
    (deps.writeIdentity ?? writeRegisteredHermesIdentity)(identity);
    return true;
  } catch (error) {
    if (
      error instanceof McpConfigConflictError ||
      error instanceof McpConfigSetupError
    ) {
      throw error;
    }
    throw hermesSetupError(error);
  }
}

export function ensureHermesMcpRegistered(): true {
  return ensureHermesMcpRegisteredWithDeps();
}

export function _ensureHermesMcpRegisteredForTests(
  deps: HermesRegistrationDeps
): true {
  return ensureHermesMcpRegisteredWithDeps(deps);
}

/**
 * Check if .mcp.json exists and has stoa configured
 */
export function hasMcpConfig(workingDirectory: string): boolean {
  try {
    const configPath = resolveProjectConfigPath(
      workingDirectory,
      CLAUDE_MCP_CONFIG_PATH,
      false
    );
    if (!existsSync(configPath)) return false;
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return !!config.mcpServers?.["stoa"];
  } catch {
    return false;
  }
}
