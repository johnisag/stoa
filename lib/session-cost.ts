import { ZERO_USAGE, computeCostUsd, type TokenUsage } from "./pricing";
import { readClaudeTranscriptRaw } from "./claude-transcript";
import type { Session } from "./db";

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

/** Sum token usage across a JSONL transcript. Pure → unit-testable. */
export function parseClaudeUsage(jsonl: string): TokenUsage {
  const total: TokenUsage = { ...ZERO_USAGE };
  const seen = new Set<string>(); // dedupe replayed/retried turns by message id
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const entry = JSON.parse(t);
      // Only assistant turns carry the authoritative per-turn usage; gating on
      // type avoids double-counting a summary/result line that echoes a total.
      if (entry?.type !== "assistant") continue;
      const usage = entry.message?.usage;
      if (!usage) continue;
      const id = entry.message?.id;
      if (id) {
        if (seen.has(id)) continue; // a killed→resumed write can re-append a turn
        seen.add(id);
      }
      total.input += usage.input_tokens || 0;
      total.output += usage.output_tokens || 0;
      total.cacheWrite += usage.cache_creation_input_tokens || 0;
      total.cacheRead += usage.cache_read_input_tokens || 0;
    } catch {
      // skip a malformed line
    }
  }
  return total;
}

/**
 * Live context-window occupancy = the input the model saw on its LAST turn
 * (input + cache read + cache write), not the running output total. That last
 * assistant turn's input bucket is the whole conversation re-sent, so it's the
 * best proxy for "how full is the window right now". Walks forward and keeps the
 * latest turn's number (transcripts are append-only). Pure → unit-testable.
 */
export function parseClaudeContextTokens(jsonl: string): number {
  let latest = 0;
  const seen = new Set<string>(); // dedupe replayed/retried turns by message id
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const entry = JSON.parse(t);
      if (entry?.type !== "assistant") continue;
      // Skip Task sub-agent (sidechain) turns: their fresh, small context isn't
      // the main thread's occupancy, and right after a sub-agent run the LAST
      // assistant entry is the sub-agent's — which would make the meter drop and
      // mask near-exhaustion (the one thing it exists to surface).
      if (entry?.isSidechain) continue;
      const usage = entry.message?.usage;
      if (!usage) continue;
      const id = entry.message?.id;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      latest =
        (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0);
    } catch {
      // skip a malformed line
    }
  }
  return latest;
}

/**
 * Read + sum usage for a Claude session from its on-disk transcript, plus the
 * live context-window occupancy (last turn's input). Async (so the cost route
 * can read all sessions concurrently without blocking the event loop). Returns
 * null when the transcript can't be read (best-effort).
 */
export async function readClaudeSessionUsage(
  cwd: string,
  claudeSessionId: string
): Promise<{ tokens: TokenUsage; contextTokens: number } | null> {
  const raw = await readClaudeTranscriptRaw(cwd, claudeSessionId);
  if (raw == null) return null;
  return {
    tokens: parseClaudeUsage(raw),
    contextTokens: parseClaudeContextTokens(raw),
  };
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
    if (
      s.agent_type !== "claude" ||
      !s.claude_session_id ||
      !s.working_directory
    ) {
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
    const usage = await readClaudeSessionUsage(
      s.working_directory,
      s.claude_session_id
    );
    const tokens = usage?.tokens ?? ZERO_USAGE;
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
