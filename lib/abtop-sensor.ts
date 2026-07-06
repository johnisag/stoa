/**
 * Optional abtop external sensor (Tier-0 / M6).
 *
 * abtop is never a dependency. When the binary is present, the monitor snapshot route
 * may ask it for one JSON sample and merge a SMALL, sanitized subset into Stoa's own
 * telemetry. Raw cwd values are used only for local de-duping; raw command lines,
 * summaries, chat tails, and file paths never cross Stoa's JSON boundary.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type { Session } from "./db";
import { monitorStatusRank } from "./agent-monitor";
import type { AgentSnapshot } from "./monitor-snapshot";
import { resolveBinary, isWindows } from "./platform";
import { mcpServerName, type SessionPort } from "./process-tree";
import type { TokenUsage } from "./pricing";

const execFileAsync = promisify(execFile);

export const ABTOP_ARGS = ["--json", "--once"] as const;

const MAX_SESSIONS = 128;
const MAX_CHILDREN_PER_SESSION = 256;
const MAX_ITEMS_PER_FIELD = 64;
const MAX_STRING = 256;
const MAX_PATH_STRING = 4096;
const MAX_COMMAND_STRING = 2048;
const MAX_SAFE_TELEMETRY_NUMBER = Number.MAX_SAFE_INTEGER;
const SENSOR_WARN_INTERVAL_MS = 60_000;
const ABTOP_TIMEOUT_MS = 2_000;
const PUBLISHABLE_ABTOP_AGENT_TYPES = new Set(["codex", "opencode"]);

let lastSensorWarnAt = 0;

export interface AbtopAgentTelemetry {
  id: string;
  agentType: string;
  sessionId: string;
  name: string;
  cwd: string | null;
  model: string | null;
  status: string;
  branch: string | null;
  contextPct: number;
  contextTokens: number;
  tokens: TokenUsage;
  childCount: number;
  mcpServers: string[];
  ports: SessionPort[];
}

type ExecFileFn = (
  file: string,
  args: string[],
  opts: { windowsHide: boolean; maxBuffer: number; timeout: number }
) => Promise<{ stdout: string }>;

const defaultExecFile: ExecFileFn = async (file, args, opts) => {
  const { stdout } = await execFileAsync(file, args, {
    ...opts,
    encoding: "utf8",
    windowsHide: true,
  });
  return { stdout };
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function limitedArray(value: unknown, limit: number): unknown[] {
  return asArray(value).slice(0, limit);
}

function boundedString(
  value: unknown,
  max = MAX_STRING,
  trim = true
): string | null {
  if (typeof value !== "string") return null;
  const text = trim ? value.trim() : value;
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function nonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(Math.floor(value), MAX_SAFE_TELEMETRY_NUMBER);
}

function percentToFraction(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(100, value) / 100;
}

function portNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 1 && value <= 65535 ? value : null;
}

function safeIdSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, MAX_STRING);
}

function safeExternalName(
  agentType: string,
  sessionId: string,
  projectName: unknown
): string {
  const name = boundedString(projectName, 128);
  if (name && /^[A-Za-z0-9_.-]{1,128}$/.test(name)) return name;
  return `${agentType} ${safeIdSegment(sessionId).slice(0, 8)}`;
}

function normalizeAgentType(value: unknown): string | null {
  const text = boundedString(value, 32)?.toLowerCase();
  if (!text || !/^[a-z0-9_-]+$/.test(text)) return null;
  return text;
}

function mapAbtopStatus(value: unknown): string {
  switch (boundedString(value, 32)?.toLowerCase()) {
    case "thinking":
    case "executing":
      return "running";
    case "waiting":
    case "ratelimited":
      return "waiting";
    case "done":
    case "unknown":
    default:
      return "idle";
  }
}

function parseChildren(value: unknown): {
  childCount: number;
  mcpServers: string[];
  ports: SessionPort[];
} {
  const mcp = new Set<string>();
  const portSet = new Set<number>();
  let childCount = 0;

  for (const item of limitedArray(value, MAX_CHILDREN_PER_SESSION)) {
    const child = asObject(item);
    if (!child) continue;
    childCount += 1;

    const command = boundedString(child.command, MAX_COMMAND_STRING, false);
    const mcpName = command ? mcpServerName(command) : null;
    if (mcpName && mcp.size < MAX_ITEMS_PER_FIELD) mcp.add(mcpName);

    const port = portNumber(child.port);
    if (port != null && portSet.size < MAX_ITEMS_PER_FIELD) portSet.add(port);
  }

  return {
    childCount,
    mcpServers: Array.from(mcp).sort((a, b) => a.localeCompare(b)),
    ports: Array.from(portSet)
      .sort((a, b) => a - b)
      .map((port) => ({ port, orphan: true })),
  };
}

function parseSession(value: unknown): AbtopAgentTelemetry | null {
  const s = asObject(value);
  if (!s) return null;

  const agentType = normalizeAgentType(s.agent_cli);
  const sessionId = boundedString(s.session_id);
  if (
    !agentType ||
    !sessionId ||
    !PUBLISHABLE_ABTOP_AGENT_TYPES.has(agentType)
  ) {
    return null;
  }

  const name = safeExternalName(agentType, sessionId, s.project_name);
  const cwd = boundedString(s.cwd, MAX_PATH_STRING);
  const contextPct = percentToFraction(s.context_percent);
  const contextWindow = nonNegativeInt(s.context_window);
  const children = parseChildren(s.children);

  return {
    id: `abtop:${agentType}:${safeIdSegment(sessionId)}`,
    agentType,
    sessionId,
    name,
    cwd,
    model: boundedString(s.model),
    status: mapAbtopStatus(s.status),
    branch: boundedString(s.git_branch),
    contextPct,
    contextTokens:
      contextWindow > 0 ? Math.round(contextWindow * contextPct) : 0,
    tokens: {
      input: nonNegativeInt(s.input_tokens),
      output: nonNegativeInt(s.output_tokens),
      cacheRead: nonNegativeInt(s.cache_read_tokens),
      cacheWrite: nonNegativeInt(s.cache_create_tokens),
    },
    childCount: children.childCount,
    mcpServers: children.mcpServers,
    ports: children.ports,
  };
}

export function parseAbtopSnapshot(value: unknown): AbtopAgentTelemetry[] {
  const snap = asObject(value);
  if (!snap) return [];
  const out: AbtopAgentTelemetry[] = [];
  for (const session of limitedArray(snap.sessions, MAX_SESSIONS)) {
    const parsed = parseSession(session);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseAbtopSnapshotJson(stdout: string): AbtopAgentTelemetry[] {
  try {
    return parseAbtopSnapshot(JSON.parse(stdout));
  } catch {
    return [];
  }
}

function cmdCommandToken(value: string): string | null {
  if (/[\r\n"&|<>()^%!]/.test(value)) return null;
  return `"${value}"`;
}

/**
 * Route a Windows .cmd/.bat shim through cmd.exe while keeping shell:false. Most abtop
 * installs are native binaries, but this keeps the same cross-platform invariant as the
 * rest of Stoa's process-launch code.
 */
export function resolveAbtopSpawn(
  binaryPath: string,
  args: readonly string[],
  onWindows: boolean
): { file: string; args: string[] } {
  if (onWindows && /\.(cmd|bat)$/i.test(binaryPath)) {
    const binaryToken = cmdCommandToken(binaryPath);
    const argTokens = args.map(cmdCommandToken);
    if (!binaryToken || argTokens.some((token) => token == null)) {
      return { file: "", args: [] };
    }
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", [binaryToken, ...argTokens].join(" ")],
    };
  }
  return { file: binaryPath, args: [...args] };
}

function warnAbtopSensor(kind: string): void {
  const now = Date.now();
  if (now - lastSensorWarnAt < SENSOR_WARN_INTERVAL_MS) return;
  lastSensorWarnAt = now;
  console.warn(`abtop sensor unavailable (${kind})`);
}

export async function collectAbtopTelemetry(deps?: {
  resolveBin?: (name: string) => string | null;
  execFileFn?: ExecFileFn;
  onWindows?: boolean;
}): Promise<AbtopAgentTelemetry[]> {
  const binary = (deps?.resolveBin ?? resolveBinary)("abtop");
  if (!binary) return [];

  const { file, args } = resolveAbtopSpawn(
    binary,
    ABTOP_ARGS,
    deps?.onWindows ?? isWindows
  );
  if (!file) {
    warnAbtopSensor("unsafe-cmd-shim-path");
    return [];
  }
  const exec = deps?.execFileFn ?? defaultExecFile;

  try {
    const { stdout } = await exec(file, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: ABTOP_TIMEOUT_MS,
    });
    try {
      return parseAbtopSnapshot(JSON.parse(stdout));
    } catch {
      warnAbtopSensor("malformed-json");
      return [];
    }
  } catch {
    warnAbtopSensor("process-error");
    return [];
  }
}

function sameAgent(session: Session, abtop: AbtopAgentTelemetry): boolean {
  return session.agent_type.toLowerCase() === abtop.agentType;
}

function matchesSession(session: Session, abtop: AbtopAgentTelemetry): boolean {
  if (!sameAgent(session, abtop)) return false;
  if (
    session.claude_session_id &&
    session.claude_session_id === abtop.sessionId
  ) {
    return true;
  }
  if (session.claude_session_id) return false;
  if (session.id === abtop.sessionId) return true;
  if (session.tmux_name && session.tmux_name === abtop.sessionId) return true;
  return false;
}

function tokenTotal(tokens: TokenUsage): number {
  return Math.min(
    tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    MAX_SAFE_TELEMETRY_NUMBER
  );
}

function unionStrings(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b])).sort((x, y) => x.localeCompare(y));
}

function unionPorts(a: number[], b: number[]): number[] {
  return Array.from(new Set([...a, ...b])).sort((x, y) => x - y);
}

function mergeAgentSnapshot(
  existing: AgentSnapshot,
  abtop: AbtopAgentTelemetry
): AgentSnapshot {
  const abtopPorts = abtop.ports.map((p) => p.port);
  const abtopOrphans = abtop.ports.filter((p) => p.orphan).map((p) => p.port);
  const hasStoaTokens = tokenTotal({
    input: existing.tokens.input,
    output: existing.tokens.output,
    cacheRead: existing.tokens.cache_read_tokens,
    cacheWrite: existing.tokens.cache_write_tokens,
  });

  const tokens =
    hasStoaTokens > 0
      ? existing.tokens
      : {
          input: abtop.tokens.input,
          output: abtop.tokens.output,
          cache_read_tokens: abtop.tokens.cacheRead,
          cache_write_tokens: abtop.tokens.cacheWrite,
          total: tokenTotal(abtop.tokens),
        };

  return {
    ...existing,
    model: existing.model || abtop.model,
    branch: existing.branch || abtop.branch,
    context_percent:
      existing.context_percent > 0
        ? existing.context_percent
        : Math.round(abtop.contextPct * 100),
    context_tokens:
      existing.context_tokens > 0
        ? existing.context_tokens
        : abtop.contextTokens,
    tokens,
    child_processes: Math.max(existing.child_processes, abtop.childCount),
    mcp_servers: unionStrings(existing.mcp_servers, abtop.mcpServers),
    ports: unionPorts(existing.ports, abtopPorts),
    orphan_ports: unionPorts(existing.orphan_ports, abtopOrphans),
  };
}

function toExternalAgentSnapshot(abtop: AbtopAgentTelemetry): AgentSnapshot {
  return {
    source: "abtop",
    id: abtop.id,
    name: abtop.name,
    agent_type: abtop.agentType,
    model: abtop.model,
    status: abtop.status,
    branch: abtop.branch,
    context_percent: Math.round(abtop.contextPct * 100),
    context_tokens: abtop.contextTokens,
    tokens: {
      input: abtop.tokens.input,
      output: abtop.tokens.output,
      cache_read_tokens: abtop.tokens.cacheRead,
      cache_write_tokens: abtop.tokens.cacheWrite,
      total: tokenTotal(abtop.tokens),
    },
    cost_usd: null,
    child_processes: abtop.childCount,
    mcp_servers: abtop.mcpServers,
    ports: abtop.ports.map((p) => p.port),
    orphan_ports: abtop.ports.filter((p) => p.orphan).map((p) => p.port),
  };
}

export function mergeAbtopAgentSnapshots(
  existing: AgentSnapshot[],
  sessions: Session[],
  abtopAgents: AbtopAgentTelemetry[]
): AgentSnapshot[] {
  if (abtopAgents.length === 0) return existing;

  const consumed = new Set<number>();
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const merged = existing.map((agent) => {
    const session = sessionById.get(agent.id);
    if (!session) return agent;

    const idx = abtopAgents.findIndex(
      (candidate, i) => !consumed.has(i) && matchesSession(session, candidate)
    );
    if (idx < 0) return agent;

    consumed.add(idx);
    return mergeAgentSnapshot(agent, abtopAgents[idx]);
  });

  abtopAgents.forEach((agent, idx) => {
    if (!consumed.has(idx)) merged.push(toExternalAgentSnapshot(agent));
  });

  return merged.sort(
    (a, b) =>
      monitorStatusRank(a.status) - monitorStatusRank(b.status) ||
      a.name.localeCompare(b.name)
  );
}
