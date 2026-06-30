/**
 * Conversation fork — per-provider (#11). Stoa forks Claude natively
 * (`claude --resume <id> --fork-session`, applied in buildAgentArgs); for a
 * provider with NO native fork primitive (Codex / Hermes / Kilo / Kimi) we fall
 * back to amux's trick: capture the parent's recent rendered scrollback and SEED
 * a fresh session with a "continue from here" prompt, delivered via the existing
 * prompt-queue (the same safe turn-boundary path #5's scheduler uses). Pairs with
 * Stoa's worktree isolation — each fork can land on its own branch.
 *
 * Pure helpers only (no I/O); the fork route owns the capture + enqueue.
 */

import { getProviderDefinition, isValidProviderId } from "./providers/registry";
import type { Session } from "./db";

/** native  — the provider has a fork flag (Claude): an exact branched conversation.
 *  scrollback — no fork primitive: a fresh session seeded with recent scrollback. */
export type ForkMode = "native" | "scrollback";

/** How many scrollback lines to capture from the parent for a scrollback fork. */
export const FORK_SCROLLBACK_LINES = 200;
/** Cap the seed length — keep the most-recent tail (where the conversation is). */
export const FORK_SEED_MAX_LENGTH = 16_000;

/**
 * The fork mechanism for a provider, or null when it can't be forked (the plain
 * shell — no agent conversation). Pure → unit-tested. Derives from the registry's
 * `supportsFork` so it stays single-sourced: a provider that gains a native fork
 * flag automatically switches from scrollback to native.
 */
export function forkModeForProvider(providerId: string): ForkMode | null {
  if (providerId === "shell" || !isValidProviderId(providerId)) return null;
  return getProviderDefinition(providerId).supportsFork
    ? "native"
    : "scrollback";
}

/**
 * The parent's stored conversation id to resume for a NATIVE fork that has not had
 * its first turn yet (so it has no own `claude_session_id`). Returns null for a
 * fork that has already started, a non-native (scrollback) fork, a non-fork
 * session, or a parent that's gone / has no id — in which case the fork must launch
 * FRESH, never resuming the parent.
 *
 * SINGLE SOURCE for the `--fork-session` parent resolution shared by the first
 * launch (app/page.tsx) and the re-attach respawn (buildSpawnForSession): without
 * it, a native fork that reconnects (a flaky mobile WS) BEFORE its first turn would
 * respawn as a brand-new blank session, silently discarding the forked context.
 * Pure → unit-tested.
 */
export function resolveNativeForkParentId(
  session: Session,
  allSessions: Session[]
): string | null {
  if (
    session.claude_session_id ||
    !session.parent_session_id ||
    forkModeForProvider(session.agent_type || "claude") !== "native"
  ) {
    return null;
  }
  const parent = allSessions.find((s) => s.id === session.parent_session_id);
  return parent?.claude_session_id || null;
}

/**
 * Strip escape/control bytes from captured scrollback so the seed is clean text an
 * agent reads as context (never terminal-driving keystrokes). Keeps only \t and \n
 * among the controls — \r (common in tmux capture as \r\n) IS stripped. Also trims
 * trailing per-line whitespace and collapses blank runs. Pure.
 */
export function sanitizeForkScrollback(text: string): string {
  return (
    text
      .replace(/\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g, "") // OSC/DCS strings
      // CSI: ESC [ params(0x30-0x3f, incl. < = > for DEC private) intermediates final
      .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[@-~]/g, "")
      .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "") // other escapes
      .replace(/\x1b/g, "") // stray ESC
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "") // C0 controls except \t,\n
      .replace(/[ \t]+$/gm, "") // trailing line whitespace
      .replace(/\n{3,}/g, "\n\n") // collapse blank-line runs
      .trim()
  );
}

/**
 * Build the "continue from here" seed prompt for a scrollback fork. Returns "" when
 * there's nothing usable to seed (the caller then forks without a seed), so an
 * empty/dead parent degrades to a plain fresh session. Keeps only the most-recent
 * FORK_SEED_MAX_LENGTH characters. Pure → unit-tested.
 */
export function buildForkSeed(scrollback: string, parentName: string): string {
  const clean = sanitizeForkScrollback(scrollback);
  if (!clean) return "";
  // Keep the most-recent tail. Slice by CODE POINT ([...clean]) not code unit so
  // the cut can't split a surrogate pair into a lone half (corrupting the start).
  const tail =
    clean.length > FORK_SEED_MAX_LENGTH
      ? [...clean].slice(-FORK_SEED_MAX_LENGTH).join("")
      : clean;
  return [
    `This session was forked from "${parentName}" (a provider without a native fork, so the prior conversation can't be resumed directly). Below is the recent terminal transcript — read it for context and continue from where it left off.`,
    ``,
    "----- transcript -----",
    tail,
    "----- end transcript -----",
  ].join("\n");
}
