/**
 * The external-memory half of compaction control (#25 remainder).
 *
 * The auto-compact trigger (#329, lib/auto-compact.ts) sends `/compact` to a
 * near-full Claude session. Compaction trades DETAIL for headroom — the model
 * keeps a summary and loses the specifics. This module adds three opt-in
 * pieces around that trade:
 *
 *   1. A CUSTOM COMPACTION PROMPT (`STOA_AUTO_COMPACT_PROMPT`): appended to
 *      the /compact command to steer what the summary preserves ("keep file
 *      paths, unresolved errors, next steps"). Empty (default) sends the bare
 *      `/compact` — byte-identical to the shipped behavior.
 *   2. A PRE-COMPACT FLUSH (`STOA_COMPACT_MEMORY=1`): just before /compact is
 *      sent, Stoa writes the recent conversation tail (deterministic — no LLM
 *      call, no extra cost) to `.stoa/compact-memory.md` in the session's
 *      working directory, so the details the summary drops survive on disk
 *      where the agent can read them back.
 *   3. A POST-COMPACT RE-INJECT (same flag): once compaction has LANDED (the
 *      live context occupancy fell back under the threshold — the transcript
 *      itself is the completion signal) and the session sits at the canonical
 *      idle-AND-no-prompt boundary, Stoa pastes a one-line pointer telling
 *      the agent where the pre-compact memory lives. One-shot per compaction,
 *      with an expiry so a dead/never-idle session doesn't hold state forever.
 *
 * Pure decisions/builders only — the fs write, the state maps, and the paste
 * live in server.ts's auto-compact tick (the budget-park pattern).
 */

import { sanitizeDigest, type TranscriptEntry } from "./summarize";

/** Where the pre-compact memory lands, relative to the session cwd. */
export const COMPACT_MEMORY_FILE = ".stoa/compact-memory.md";

/** Opt-in gate for the flush + re-inject (the external-memory half). */
export function compactMemoryEnabled(): boolean {
  return process.env.STOA_COMPACT_MEMORY === "1";
}

const MAX_PROMPT_CHARS = 400;

/**
 * The operator's custom compaction instruction, or null for the bare
 * /compact. Sanitized to ONE line (it rides a pasted slash command):
 * control chars stripped, newlines collapsed to spaces, length capped.
 */
export function customCompactPrompt(): string | null {
  const raw = process.env.STOA_AUTO_COMPACT_PROMPT;
  if (!raw) return null;
  const oneLine = sanitizeDigest(raw)
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, MAX_PROMPT_CHARS)
    .trim();
  return oneLine || null;
}

/** The exact line pasted into the session: `/compact` + optional steering. */
export function buildCompactCommand(prompt: string | null): string {
  return prompt ? `/compact ${prompt}` : "/compact";
}

/** Default cap for the memory file — roomy enough for real context, small
 *  enough that the agent can re-read it in one gulp. */
const MAX_MEMORY_CHARS = 24_000;

/**
 * The pre-compact memory document: session metadata + the conversation tail,
 * TAIL-BIASED (the newest entries are what compaction most needs to preserve;
 * older ones drop first when the cap bites). Deterministic and pure.
 */
export function buildCompactMemoryMarkdown(input: {
  sessionName: string;
  model: string | null;
  contextPct: number;
  nowIso: string;
  entries: TranscriptEntry[];
  maxChars?: number;
}): string {
  const cap = input.maxChars ?? MAX_MEMORY_CHARS;
  const header = [
    `# Pre-compact memory — ${sanitizeDigest(input.sessionName)}`,
    "",
    "Saved automatically by Stoa just before `/compact`. The compaction",
    "summary keeps the gist and drops detail — this file holds the recent",
    "conversation tail verbatim. Read it if post-compaction context is",
    "missing something you need.",
    "",
    `- Model: ${input.model ?? "unknown"}`,
    `- Context at flush: ~${Math.round(input.contextPct * 100)}%`,
    `- Saved: ${input.nowIso}`,
    "",
    "## Recent conversation (oldest → newest)",
    "",
  ].join("\n");

  // Walk backwards accumulating until the cap, then restore order.
  const blocks: string[] = [];
  let used = 0;
  for (let i = input.entries.length - 1; i >= 0; i--) {
    const e = input.entries[i];
    const text = sanitizeDigest(e.text);
    if (!text) continue;
    const block = `**${e.role === "user" ? "User" : "Assistant"}:**\n${text}\n`;
    if (used + block.length > cap) break;
    blocks.push(block);
    used += block.length;
  }
  blocks.reverse();

  return (
    header +
    (blocks.length > 0 ? blocks.join("\n") : "_(no conversation captured)_\n")
  );
}

/** The one-line pointer pasted into the session after compaction lands. */
export function buildReinjectMessage(): string {
  return (
    "[stoa auto-compact] The conversation was just compacted. The detailed " +
    `pre-compact state (recent conversation tail) was saved to ${COMPACT_MEMORY_FILE} — ` +
    "read that file if any context you need is missing from the summary."
  );
}

/** Give /compact this long to run before the pointer may be injected. */
export const REINJECT_MIN_DELAY_MS = 2 * 60 * 1000;
/** Abandon the pointer if the session never reaches a clean boundary. */
export const REINJECT_MAX_WAIT_MS = 30 * 60 * 1000;

export type ReinjectAction = "wait" | "inject" | "expire";

/**
 * Whether the post-compact pointer fires this tick. Ordered: expire first
 * (stale pendings never linger), then the settle delay, then the completion
 * signal (context occupancy back UNDER the threshold — an unknown occupancy
 * after the settle delay counts as landed, since post-compact transcripts are
 * exactly the readable kind), then the canonical unattended-write boundary.
 */
export function nextReinjectAction(input: {
  pendingSinceMs: number;
  nowMs: number;
  isIdle: boolean;
  hasPrompt: boolean;
  contextPct: number | null;
  threshold: number;
  minDelayMs?: number;
  maxWaitMs?: number;
}): ReinjectAction {
  const minDelay = input.minDelayMs ?? REINJECT_MIN_DELAY_MS;
  const maxWait = input.maxWaitMs ?? REINJECT_MAX_WAIT_MS;
  const waited = input.nowMs - input.pendingSinceMs;
  if (waited > maxWait) return "expire";
  if (waited < minDelay) return "wait";
  if (input.contextPct != null && input.contextPct >= input.threshold) {
    return "wait"; // compaction hasn't landed yet
  }
  if (!input.isIdle || input.hasPrompt) return "wait";
  return "inject";
}
