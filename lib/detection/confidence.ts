/**
 * Agent state confidence signals — inspired by Herdr's AgentDetection struct.
 *
 * These are evidence-based flags that tell callers WHY the detector classified
 * a screen a certain way, so downstream consumers (Fleet Board, notifications,
 * auto-steer) can make better decisions than "the status string alone".
 *
 * Each flag is derived from the RENDERED screen (the same capture the status
 * detector reads), never from raw byte streams — a spinner overwrites its line
 * in place, so raw bytes would break the heuristics.
 */

/**
 * Confidence metadata attached to every status evaluation.
 */
export interface StatusConfidence {
  /**
   * True when the screen shows live working chrome — a spinner, "esc to
   * interrupt", or a whimsical "tokens" status line. The strongest "this
   * agent is actively working" signal short of raw PTY activity.
   */
  visibleWorking: boolean;

  /**
   * True when the screen shows live UI chrome that needs human input — a
   * Yes/No prompt, "Allow?", "Enter to confirm / Esc to cancel", etc.
   * Stronger than arbitrary prompt-like text in scrollback.
   */
  visibleBlocker: boolean;

  /**
   * True when the screen shows live idle chrome — a bare shell prompt ($, >, %)
   * or a known-agent idle cue. Indicates the agent finished and is ready for
   * the next input.
   */
  visibleIdle: boolean;

  /**
   * True when the screen is an agent-owned viewer showing transcript/history
   * instead of the live prompt state (e.g. Claude's "showing detailed
   * transcript" overlay). When this is set, the status should NOT be updated
   * — the user is looking at history, not the live agent state.
   */
  skipStateUpdate: boolean;
}

export const NO_CONFIDENCE: StatusConfidence = {
  visibleWorking: false,
  visibleBlocker: false,
  visibleIdle: false,
  skipStateUpdate: false,
};

// Patterns indicating the agent is showing a transcript/history viewer rather
// than live state. Borrowed from Herdr's claude.toml transcript_viewer rule.
const TRANSCRIPT_VIEWER_PATTERNS: RegExp[] = [
  /showing detailed transcript/i,
  /ctrl\+o.*to toggle/i,
  /ctrl\+e.*show all/i,
  /ctrl\+e.*collapse/i,
  /[↑↓].*scroll/i,
  /\?.*for shortcuts/i,
];

// Idle chrome patterns — a bare shell prompt or a known-agent idle cue.
const IDLE_CHROME_PATTERNS: RegExp[] = [
  /\$\s*$/m, // bash/sh prompt
  />\s*$/m, // generic prompt
  /%\s*$/m, // zsh/csh prompt
];

/**
 * Derive confidence signals from the rendered screen content.
 *
 * Takes the same content the status detector already captured — no extra
 * round-trip. The patterns mirror those in checkBusyIndicators /
 * checkWaitingPatterns but are extracted here as independent evidence flags.
 */
export function deriveConfidence(
  content: string,
  busy: boolean,
  waiting: boolean
): StatusConfidence {
  // skipStateUpdate: check the bottom region for transcript-viewer chrome.
  // Reading the last 5 lines mirrors the waiting-pattern scan window.
  const bottomRegion = content.split("\n").slice(-5).join("\n");
  const skipStateUpdate = TRANSCRIPT_VIEWER_PATTERNS.some((p) =>
    p.test(bottomRegion)
  );

  // Idle chrome: check the very last non-empty line for a bare prompt.
  const lines = content.split("\n").filter(Boolean);
  const lastLine = lines.length ? lines[lines.length - 1] : "";
  const visibleIdle =
    !busy &&
    !waiting &&
    !skipStateUpdate &&
    IDLE_CHROME_PATTERNS.some((p) => p.test(lastLine));

  return {
    visibleWorking: busy,
    visibleBlocker: waiting,
    visibleIdle,
    skipStateUpdate,
  };
}
