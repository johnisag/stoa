import { formatTerminalTextForAgent } from "./path-display";

/**
 * Normalize an edited prompt for sending to the agent: strip dangerous C0
 * controls (keystroke-injection vectors in the pty) but keep tab/newline so a
 * multi-line prompt rides in as one bracketed paste, and trim surrounding
 * whitespace. Returns "" when nothing meaningful is left (caller blocks send).
 *
 * Used by the "Rewind & re-run" composer (SnapshotTimeline): the composer opens
 * EMPTY (a snapshot's summary is the agent's last rendered line, not the user's
 * prompt — re-running it would send chrome), so the operator types a fresh
 * instruction to run from that point.
 */
export function normalizeEditedPrompt(text: string): string {
  return formatTerminalTextForAgent(text ?? "");
}
