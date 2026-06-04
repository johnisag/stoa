import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import {
  findClaudeProjectDir,
  claudeProjectDirName,
  expandHome,
} from "./platform";
import { ZERO_USAGE, computeCostUsd, type TokenUsage } from "./pricing";
import type { Session } from "./db";

export interface SessionCost {
  name: string;
  model: string | null;
  tokens: TokenUsage;
  costUsd: number | null;
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
 * Read + sum usage for a Claude session from its on-disk transcript. Async (so
 * the cost route can read all sessions concurrently without blocking the event
 * loop). Returns null when the transcript can't be read (best-effort).
 */
export async function readClaudeSessionUsage(
  cwd: string,
  claudeSessionId: string
): Promise<TokenUsage | null> {
  // The id is interpolated into the path and can originate from an external
  // POST field — reject anything that isn't a plain id token so it can't
  // traverse out of ~/.claude/projects.
  if (!/^[\w-]+$/.test(claudeSessionId)) return null;
  try {
    const expanded = expandHome(cwd);
    const projectDir =
      findClaudeProjectDir(expanded) ||
      join(homedir(), ".claude", "projects", claudeProjectDirName(expanded));
    // readFile throws ENOENT if it's missing → caught below (no existsSync race).
    const raw = await readFile(
      join(projectDir, `${claudeSessionId}.jsonl`),
      "utf-8"
    );
    return parseClaudeUsage(raw);
  } catch {
    return null;
  }
}

/**
 * Estimated cost for every session, keyed by id (Claude-only; others
 * supported:false). Reads transcripts concurrently. Shared by the cost API and
 * the server-side budget enforcement loop.
 */
export async function computeSessionCosts(
  sessions: Session[]
): Promise<Record<string, SessionCost>> {
  const entries = await Promise.all(
    sessions.map(async (s): Promise<[string, SessionCost]> => {
      const base = { name: s.name, model: s.model };
      if (
        s.agent_type !== "claude" ||
        !s.claude_session_id ||
        !s.working_directory
      ) {
        return [
          s.id,
          { ...base, tokens: ZERO_USAGE, costUsd: null, supported: false },
        ];
      }
      const tokens =
        (await readClaudeSessionUsage(
          s.working_directory,
          s.claude_session_id
        )) ?? ZERO_USAGE;
      return [
        s.id,
        {
          ...base,
          tokens,
          costUsd: computeCostUsd(tokens, s.model),
          supported: true,
        },
      ];
    })
  );
  return Object.fromEntries(entries);
}
