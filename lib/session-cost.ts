import { stat as fsStat } from "fs/promises";
import { ZERO_USAGE, computeCostUsd, type TokenUsage } from "./pricing";
import {
  readClaudeTranscriptRaw,
  resolveClaudeTranscriptPath,
} from "./claude-transcript";
import {
  createStatGatedCache,
  transcriptCacheEnabled,
} from "./transcript-cache";
import type { Session } from "./db";
import type { AgentType } from "./providers";

export interface SessionCost {
  name: string;
  model: string | null;
  tokens: TokenUsage;
  costUsd: number | null;
  /**
   * Live context-window occupancy: the tokens the model SAW on its most recent
   * turn (input + cache read + cache write), i.e. how full the window is right
   * now — NOT the cumulative `tokens` total (which grows every turn). 0 when the
   * transcript carries no usage yet. Powers the per-session context meter.
   */
  contextTokens: number;
  /** false for non-Claude agents (no comparable transcript) — shown as "—". */
  supported: boolean;
}

/**
 * Token accounting from a Claude Code session transcript (the JSONL Stoa already
 * reads for /summarize). Each assistant line carries `message.usage`
 * {input_tokens, output_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens} — disjoint buckets, so summing them is correct.
 * Claude-only today (Codex/Hermes don't expose a comparable transcript) —
 * callers treat other agents as unsupported.
 */

type ClaudeUsage = { tokens: TokenUsage; contextTokens: number };

/**
 * Single-pass core (#42): ONE walk over the transcript produces BOTH the
 * cumulative usage total and the live context-window occupancy — the JSONL was
 * previously walked twice per read, and this sits under every cost consumer's
 * tick. The walk preserves each former parser's exact semantics, including
 * their SEPARATE message-id dedupe sets: the context pass skips sidechain
 * turns BEFORE recording ids, so a later main-thread turn reusing a sidechain
 * turn's id still becomes the context reading while staying deduped from the
 * cumulative total. Pure → unit-testable.
 */
export function parseClaudeTranscriptUsage(jsonl: string): ClaudeUsage {
  const tokens: TokenUsage = { ...ZERO_USAGE };
  let contextTokens = 0;
  // Dedupe replayed/retried turns by message id (a killed→resumed write can
  // re-append a turn) — one set per accumulator, matching the former two walks.
  const seenTotal = new Set<string>();
  const seenContext = new Set<string>();
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let entry;
    try {
      entry = JSON.parse(t);
    } catch {
      continue; // skip a malformed line
    }
    // Only assistant turns carry the authoritative per-turn usage; gating on
    // type avoids double-counting a summary/result line that echoes a total.
    if (entry?.type !== "assistant") continue;
    const usage = entry.message?.usage;
    if (!usage) continue;
    const id = entry.message?.id;
    // Cumulative total: every assistant turn counts, sidechain included.
    if (!id || !seenTotal.has(id)) {
      if (id) seenTotal.add(id);
      tokens.input += usage.input_tokens || 0;
      tokens.output += usage.output_tokens || 0;
      tokens.cacheWrite += usage.cache_creation_input_tokens || 0;
      tokens.cacheRead += usage.cache_read_input_tokens || 0;
    }
    // Context occupancy: keep the LATEST turn's number (transcripts are
    // append-only), skipping Task sub-agent (sidechain) turns — their fresh,
    // small context isn't the main thread's occupancy, and right after a
    // sub-agent run the LAST assistant entry is the sub-agent's — which would
    // make the meter drop and mask near-exhaustion (the one thing it exists to
    // surface).
    if (!entry.isSidechain && (!id || !seenContext.has(id))) {
      if (id) seenContext.add(id);
      contextTokens =
        (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0);
    }
  }
  return { tokens, contextTokens };
}

/** Sum token usage across a JSONL transcript. Pure → unit-testable. Thin
 *  wrapper over the single-pass core (#42). */
export function parseClaudeUsage(jsonl: string): TokenUsage {
  return parseClaudeTranscriptUsage(jsonl).tokens;
}

/**
 * Live context-window occupancy = the input the model saw on its LAST turn
 * (input + cache read + cache write), not the running output total. That last
 * assistant turn's input bucket is the whole conversation re-sent, so it's the
 * best proxy for "how full is the window right now". Thin wrapper over the
 * single-pass core (#42). Pure → unit-testable.
 */
export function parseClaudeContextTokens(jsonl: string): number {
  return parseClaudeTranscriptUsage(jsonl).contextTokens;
}

/**
 * The fork-cost baseline stored on a native fork — the parent's cumulative usage
 * AT FORK TIME as a JSON TokenUsage — or null when absent/unparseable. Pure →
 * unit-tested. (#1: a native Claude fork inherits the parent's whole transcript.)
 */
export function parseForkBaseline(
  json: string | null | undefined
): TokenUsage | null {
  if (!json) return null;
  try {
    const b = JSON.parse(json) as Partial<TokenUsage>;
    if (!b || typeof b !== "object") return null;
    return {
      input: Number(b.input) || 0,
      output: Number(b.output) || 0,
      cacheRead: Number(b.cacheRead) || 0,
      cacheWrite: Number(b.cacheWrite) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Net a fork baseline out of cumulative usage, clamping each bucket at >= 0. A
 * native fork's transcript = the inherited parent history + the fork's own turns,
 * so the fork's OWN spend is the total minus the parent-at-fork baseline. A null
 * baseline (the common case) returns the usage unchanged. Pure → unit-tested.
 */
export function netForkUsage(
  tokens: TokenUsage,
  baseline: TokenUsage | null
): TokenUsage {
  if (!baseline) return tokens;
  return {
    input: Math.max(0, tokens.input - baseline.input),
    output: Math.max(0, tokens.output - baseline.output),
    cacheRead: Math.max(0, tokens.cacheRead - baseline.cacheRead),
    cacheWrite: Math.max(0, tokens.cacheWrite - baseline.cacheWrite),
  };
}

/**
 * Stat-gated cache of parsed transcript usage (#18), shared across EVERY cost
 * consumer — the cost route, the budget tick (30s), the cost sampler (60s), the
 * auto-compact tick (60s), analytics, and the monitor all reach transcripts through
 * `readClaudeSessionUsage`, so one cache spares them re-reading + re-parsing the
 * same large append-only JSONL each tick (the biggest avoidable steady-state IO).
 * Bounded so a long-lived fleet can't grow it without limit.
 */
const claudeUsageCache = createStatGatedCache<ClaudeUsage>({ max: 512 });

/** Uncached read + single-pass parse of a Claude transcript (the cache's load
 *  step and the kill-switch fallback). Null when the transcript can't be read. */
async function loadClaudeUsage(
  cwd: string,
  claudeSessionId: string
): Promise<ClaudeUsage | null> {
  const raw = await readClaudeTranscriptRaw(cwd, claudeSessionId);
  if (raw == null) return null;
  return parseClaudeTranscriptUsage(raw);
}

/**
 * Read + sum usage for a Claude session from its on-disk transcript, plus the live
 * context-window occupancy (last turn's input). Async (so the cost route can read
 * all sessions concurrently without blocking the event loop). Returns null when the
 * transcript can't be read (best-effort). Served from a stat-gated cache: a cache
 * hit costs one `resolve` + one `stat` and no read/parse, and is invalidated the
 * instant the transcript's mtime or size changes (so budget/cost decisions never
 * act on stale usage). Fork baselines are applied by the CALLER after this returns,
 * so caching the raw parsed usage is safe.
 */
export async function readClaudeSessionUsage(
  cwd: string,
  claudeSessionId: string
): Promise<ClaudeUsage | null> {
  // Kill switch first, so a disabled cache never even stats the file and behaves
  // byte-identically to the pre-cache path (read + parse on every call).
  if (!transcriptCacheEnabled()) return loadClaudeUsage(cwd, claudeSessionId);
  const path = resolveClaudeTranscriptPath(cwd, claudeSessionId);
  if (!path) return null;
  return claudeUsageCache.get(path, {
    stat: async (p) => {
      try {
        const s = await fsStat(p);
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null; // missing/unreadable → treated as a cache miss + eviction
      }
    },
    load: () => loadClaudeUsage(cwd, claudeSessionId),
  });
}

/** Reads a provider's on-disk transcript and returns cumulative token usage +
 *  the live context-window occupancy, or null when it can't be read. */
export type UsageReader = (
  cwd: string,
  sessionId: string
) => Promise<{ tokens: TokenUsage; contextTokens: number } | null>;

/**
 * Per-provider transcript usage readers — the single seam for "which agents have
 * a cost estimate". A provider with an entry here gets token tracking, the cost
 * UI, AND persistence (#15) automatically; one without is reported supported:false
 * (shown "—"). Claude is the only agent today that writes a parseable per-turn
 * usage transcript (the JSONL Stoa already reads for /summarize); Codex / Hermes /
 * Kilo / Kimi expose no comparable stream yet, so they're a reader away — register
 * one here and the whole cost surface lights up for it. See docs/ROADMAP.md.
 */
const USAGE_READERS: Partial<Record<AgentType, UsageReader>> = {
  claude: (cwd, sessionId) => readClaudeSessionUsage(cwd, sessionId),
};

/** The usage reader for a provider, or undefined when its cost isn't trackable. */
export function costReaderFor(agentType: string): UsageReader | undefined {
  return USAGE_READERS[agentType as AgentType];
}

/**
 * Estimated cost for every session, keyed by id (Claude-only; others
 * supported:false). Reads transcripts with BOUNDED concurrency (a large window
 * could otherwise fan out hundreds of concurrent file reads → fd exhaustion +
 * a memory spike). Shared by the cost API, the analytics layer, and the
 * server-side budget enforcement loop.
 */
const COST_READ_CONCURRENCY = 12;

export async function computeSessionCosts(
  sessions: Session[]
): Promise<Record<string, SessionCost>> {
  const mapOne = async (s: Session): Promise<[string, SessionCost]> => {
    const base = { name: s.name, model: s.model };
    const reader = costReaderFor(s.agent_type);
    // `claude_session_id` is the stored transcript id (banner-capture providers
    // reuse the column); a provider needs a reader AND a located transcript + cwd.
    if (!reader || !s.claude_session_id || !s.working_directory) {
      return [
        s.id,
        {
          ...base,
          tokens: ZERO_USAGE,
          costUsd: null,
          contextTokens: 0,
          supported: false,
        },
      ];
    }
    const usage = await reader(s.working_directory, s.claude_session_id);
    // Net out a native fork's inherited parent history (#1) so only the fork's own
    // spend counts. contextTokens is the live window occupancy (last turn) and
    // legitimately includes the inherited context, so it's NOT baseline-adjusted.
    const tokens = netForkUsage(
      usage?.tokens ?? ZERO_USAGE,
      parseForkBaseline(s.fork_cost_baseline)
    );
    return [
      s.id,
      {
        ...base,
        tokens,
        costUsd: computeCostUsd(tokens, s.model),
        contextTokens: usage?.contextTokens ?? 0,
        supported: true,
      },
    ];
  };

  // Process in fixed-size batches so at most COST_READ_CONCURRENCY transcripts
  // are read at once, regardless of how many sessions the window holds.
  const entries: Array<[string, SessionCost]> = [];
  for (let i = 0; i < sessions.length; i += COST_READ_CONCURRENCY) {
    const batch = sessions.slice(i, i + COST_READ_CONCURRENCY);
    entries.push(...(await Promise.all(batch.map(mapOne))));
  }
  return Object.fromEntries(entries);
}
