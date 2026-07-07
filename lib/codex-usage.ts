import Database from "better-sqlite3";
import { stat as fsStat, readFile } from "fs/promises";
import path from "path";
import type { Session } from "./db";
import { ZERO_USAGE, type TokenUsage } from "./pricing";
import { getSessionBackend, type SessionActivity } from "./session-backend";
import { backendKeyForSession } from "./providers/registry";
import {
  createStatGatedCache,
  transcriptCacheEnabled,
} from "./transcript-cache";
import { expandHome, homeDir, normalizePathForCompare } from "./platform";

export interface CodexUsage {
  tokens: TokenUsage;
  standardTokens: TokenUsage;
  longContextTokens: TokenUsage;
  contextTokens: number;
  contextWindow: number | null;
  longContext?: boolean;
  model?: string | null;
}

type RawTokenUsage = {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
};

export interface CodexThreadRow {
  id: string;
  rollout_path: string;
  cwd: string;
  created_at: number;
  updated_at: number;
  model?: string | null;
  source?: string | null;
  thread_source?: string | null;
}

const codexUsageCache = createStatGatedCache<CodexUsage>({ max: 512 });
const CODEX_THREAD_ACTIVITY_GRACE_SECONDS = 10;
const CODEX_LONG_CONTEXT_THRESHOLD = 272_000;

type VerifiedCodexThread = {
  threadId: string;
  activitySeconds: number | null;
  verifiedAtMs: number;
};

const verifiedCodexThreads = new Map<string, VerifiedCodexThread>();

function nonNegativeNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function positiveInt(value: unknown): number | null {
  const n = Math.trunc(nonNegativeNumber(value));
  return n > 0 ? n : null;
}

function codexContextTokens(raw: RawTokenUsage | null): number {
  const input = nonNegativeNumber(raw?.input_tokens);
  if (input > 0) return input;
  const total = nonNegativeNumber(raw?.total_tokens);
  if (total <= 0) return 0;
  return Math.max(0, total - nonNegativeNumber(raw?.output_tokens));
}

function openAiUsageToTokenUsage(raw: RawTokenUsage | null): TokenUsage {
  if (!raw) return { ...ZERO_USAGE };
  const inputWithCached = nonNegativeNumber(raw.input_tokens);
  const cached = Math.min(
    inputWithCached,
    nonNegativeNumber(raw.cached_input_tokens)
  );
  return {
    input: Math.max(0, inputWithCached - cached),
    output: nonNegativeNumber(raw.output_tokens),
    cacheRead: cached,
    cacheWrite: 0,
  };
}

function addTokenUsage(target: TokenUsage, add: TokenUsage): void {
  target.input += add.input;
  target.output += add.output;
  target.cacheRead += add.cacheRead;
  target.cacheWrite += add.cacheWrite;
}

function subtractRawUsage(
  current: RawTokenUsage,
  previous: RawTokenUsage | null
): RawTokenUsage {
  if (!previous) return current;
  if (
    nonNegativeNumber(current.input_tokens) <
      nonNegativeNumber(previous.input_tokens) ||
    nonNegativeNumber(current.cached_input_tokens) <
      nonNegativeNumber(previous.cached_input_tokens) ||
    nonNegativeNumber(current.output_tokens) <
      nonNegativeNumber(previous.output_tokens)
  ) {
    return current;
  }
  return {
    input_tokens: Math.max(
      0,
      nonNegativeNumber(current.input_tokens) -
        nonNegativeNumber(previous.input_tokens)
    ),
    cached_input_tokens: Math.max(
      0,
      nonNegativeNumber(current.cached_input_tokens) -
        nonNegativeNumber(previous.cached_input_tokens)
    ),
    output_tokens: Math.max(
      0,
      nonNegativeNumber(current.output_tokens) -
        nonNegativeNumber(previous.output_tokens)
    ),
  };
}

function isUserCodexThread(row: CodexThreadRow): boolean {
  if (row.thread_source === "user") return true;
  if (row.thread_source != null) return false;
  if (!row.source) return true;
  try {
    const source = JSON.parse(row.source);
    if (source && typeof source === "object") {
      const keys = new Set(Object.keys(source));
      if (keys.has("subagent") || keys.has("automation")) return false;
    }
  } catch {
    // Legacy user rows use plain strings such as "vscode".
  }
  return (
    !row.source.includes('"subagent"') && !row.source.includes('"automation"')
  );
}

function verifiedThreadIdForSession(session: Session): string | null {
  return verifiedCodexThreads.get(session.id)?.threadId ?? null;
}

export function markCodexThreadVerified(
  sessionId: string,
  threadId: string,
  activitySeconds: number | null | undefined
): void {
  verifiedCodexThreads.set(sessionId, {
    threadId,
    activitySeconds:
      activitySeconds == null || !Number.isFinite(activitySeconds)
        ? null
        : Math.trunc(activitySeconds),
    verifiedAtMs: Date.now(),
  });
}

export function clearCodexThreadVerification(sessionId: string): void {
  verifiedCodexThreads.delete(sessionId);
}

async function listBackendSessionsWithActivity(): Promise<SessionActivity[]> {
  const backend = getSessionBackend();
  try {
    const withActivity = await backend.listWithActivity();
    if (withActivity.length > 0) return withActivity;
  } catch {
    // Fall through to the name-only backend list below.
  }
  try {
    return (await backend.list()).map((name) => ({ name, activity: null }));
  } catch {
    return [];
  }
}

export async function refreshCodexThreadVerifications(
  sessions: Session[]
): Promise<void> {
  const codexSessions = sessions.filter((s) => s.agent_type === "codex");
  const liveCodexIds = new Set(codexSessions.map((s) => s.id));
  for (const sessionId of verifiedCodexThreads.keys()) {
    if (!liveCodexIds.has(sessionId)) clearCodexThreadVerification(sessionId);
  }
  if (codexSessions.length === 0) return;
  const activities = await listBackendSessionsWithActivity();
  const activityByName = new Map(activities.map((s) => [s.name, s.activity]));
  for (const session of codexSessions) {
    const activity = activityByName.get(backendKeyForSession(session));
    if (activity == null || !Number.isFinite(activity)) {
      clearCodexThreadVerification(session.id);
      continue;
    }
    const threadId = resolveCodexThreadIdForSession(session, activity);
    if (threadId) {
      markCodexThreadVerified(session.id, threadId, activity);
    } else {
      clearCodexThreadVerification(session.id);
    }
  }
}

export function stripExtendedWindowsPrefix(p: string): string {
  if (!p.startsWith("\\\\?\\")) return p;
  if (p.startsWith("\\\\?\\UNC\\"))
    return `\\\\${p.slice("\\\\?\\UNC\\".length)}`;
  return p.slice("\\\\?\\".length);
}

function normalizeCodexCwd(cwd: string): string {
  return normalizePathForCompare(stripExtendedWindowsPrefix(expandHome(cwd)));
}

function sessionCreatedAtSeconds(session: Session): number | null {
  const raw = session.created_at;
  if (!raw) return null;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function codexStateDbPath(): string {
  return path.join(homeDir(), ".codex", "state_5.sqlite");
}

function withCodexDb<T>(fn: (db: Database.Database) => T): T | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(codexStateDbPath(), {
      readonly: true,
      fileMustExist: true,
    });
    return fn(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function resolveThreadById(threadId: string): CodexThreadRow | null {
  const clean = threadId.trim();
  if (!clean) return null;
  return withCodexDb((db) => {
    const row = db
      .prepare(
        `SELECT id, rollout_path, cwd, created_at, updated_at, model, source, thread_source
         FROM threads
         WHERE id = ?
         LIMIT 1`
      )
      .get(clean) as CodexThreadRow | undefined;
    return row ?? null;
  });
}

export function resolveCodexThreadIdFromRows(
  session: Session,
  rows: CodexThreadRow[],
  activitySeconds: number | null | undefined
): string | null {
  if (
    !session.working_directory ||
    activitySeconds == null ||
    !Number.isFinite(activitySeconds)
  ) {
    return null;
  }
  const targetCwd = normalizeCodexCwd(session.working_directory);
  const createdAt = sessionCreatedAtSeconds(session);
  const minCreatedAt = createdAt == null ? 0 : createdAt - 300;
  const activity = Math.trunc(activitySeconds);
  const matches = rows.filter(
    (row) =>
      isUserCodexThread(row) &&
      normalizeCodexCwd(row.cwd) === targetCwd &&
      row.created_at >= minCreatedAt &&
      Math.abs(row.updated_at - activity) <= CODEX_THREAD_ACTIVITY_GRACE_SECONDS
  );
  return matches.length === 1 ? matches[0].id : null;
}

export function resolveCodexThreadIdForSession(
  session: Session,
  activitySeconds: number | null | undefined
): string | null {
  if (
    !session.working_directory ||
    activitySeconds == null ||
    !Number.isFinite(activitySeconds)
  ) {
    return null;
  }
  const activity = Math.trunc(activitySeconds);
  const createdAt = sessionCreatedAtSeconds(session);
  const minCreatedAt = createdAt == null ? 0 : createdAt - 300;
  return withCodexDb((db) => {
    const rows = db
      .prepare(
        `SELECT id, rollout_path, cwd, created_at, updated_at, model, source, thread_source
         FROM threads
         WHERE created_at >= ?
           AND updated_at BETWEEN ? AND ?
           AND (
             thread_source = 'user'
             OR (
               thread_source IS NULL
               AND (
                 source IS NULL
                 OR (
                   source NOT LIKE '%"subagent"%'
                   AND source NOT LIKE '%"automation"%'
                 )
               )
             )
           )
         ORDER BY updated_at DESC
         LIMIT 50`
      )
      .all(
        minCreatedAt,
        activity - CODEX_THREAD_ACTIVITY_GRACE_SECONDS,
        activity + CODEX_THREAD_ACTIVITY_GRACE_SECONDS
      ) as CodexThreadRow[];
    return resolveCodexThreadIdFromRows(session, rows, activity);
  });
}

function resolveThreadForSession(session: Session): CodexThreadRow | null {
  if (!session.working_directory) return null;
  const threadId = verifiedThreadIdForSession(session);
  if (!threadId) return null;
  const row = resolveThreadById(threadId);
  if (!row?.rollout_path) return null;
  if (!isUserCodexThread(row)) return null;
  if (
    normalizeCodexCwd(row.cwd) !== normalizeCodexCwd(session.working_directory)
  ) {
    return null;
  }
  return row;
}

export function resolveCodexRolloutPath(session: Session): string | null {
  const row = resolveThreadForSession(session);
  if (!row) return null;
  return stripExtendedWindowsPrefix(expandHome(row.rollout_path));
}

export function parseCodexRolloutUsage(jsonl: string): CodexUsage {
  let total: RawTokenUsage | null = null;
  let previousTotal: RawTokenUsage | null = null;
  let last: RawTokenUsage | null = null;
  let contextWindow: number | null = null;
  const standardTokens: TokenUsage = { ...ZERO_USAGE };
  const longContextTokens: TokenUsage = { ...ZERO_USAGE };

  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      !entry ||
      typeof entry !== "object" ||
      (entry as { type?: unknown }).type !== "event_msg"
    ) {
      continue;
    }
    const payload = (entry as { payload?: unknown }).payload;
    if (
      !payload ||
      typeof payload !== "object" ||
      (payload as { type?: unknown }).type !== "token_count"
    ) {
      continue;
    }
    const info = (payload as { info?: unknown }).info;
    if (!info || typeof info !== "object") continue;
    const nextTotal = (info as { total_token_usage?: RawTokenUsage })
      .total_token_usage;
    last =
      (info as { last_token_usage?: RawTokenUsage }).last_token_usage ?? last;
    if (nextTotal) {
      const delta = openAiUsageToTokenUsage(
        subtractRawUsage(nextTotal, previousTotal)
      );
      if (
        nonNegativeNumber(last?.input_tokens) > CODEX_LONG_CONTEXT_THRESHOLD
      ) {
        addTokenUsage(longContextTokens, delta);
      } else {
        addTokenUsage(standardTokens, delta);
      }
      total = nextTotal;
      previousTotal = nextTotal;
    }
    contextWindow =
      positiveInt(
        (info as { model_context_window?: unknown }).model_context_window
      ) ?? contextWindow;
  }

  const tokens: TokenUsage = { ...standardTokens };
  addTokenUsage(tokens, longContextTokens);

  return {
    tokens,
    standardTokens,
    longContextTokens,
    contextTokens: codexContextTokens(last),
    contextWindow,
    longContext:
      longContextTokens.input +
        longContextTokens.output +
        longContextTokens.cacheRead +
        longContextTokens.cacheWrite >
      0,
  };
}

async function loadCodexUsage(rolloutPath: string): Promise<CodexUsage | null> {
  try {
    return parseCodexRolloutUsage(await readFile(rolloutPath, "utf8"));
  } catch {
    return null;
  }
}

export async function readCodexSessionUsage(
  session: Session
): Promise<CodexUsage | null | undefined> {
  const row = resolveThreadForSession(session);
  if (!row) return undefined;
  const rolloutPath = stripExtendedWindowsPrefix(expandHome(row.rollout_path));
  const attachModel = (usage: CodexUsage | null) =>
    usage ? { ...usage, model: row.model ?? null } : null;
  if (!transcriptCacheEnabled()) {
    return attachModel(await loadCodexUsage(rolloutPath));
  }
  const usage = await codexUsageCache.get(rolloutPath, {
    stat: async (p) => {
      try {
        const s = await fsStat(p);
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    },
    load: () => loadCodexUsage(rolloutPath),
  });
  return attachModel(usage);
}
