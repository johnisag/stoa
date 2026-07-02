/**
 * Copy-as-Markdown (#40) — turn captured terminal text into a fenced code block
 * ready to paste into an issue / notes / channel. Pure and browser-safe: it is
 * imported by client components, so no node builtins — path-display.ts is the
 * browser-safe sibling of lib/platform.ts (see AGENTS.md).
 */

import { formatTerminalTextForAgent } from "./path-display";

// Control bytes built via String.fromCharCode so this file contains no
// control-char escape literals (tooling that interprets escapes can corrupt
// them into real bytes — see the literal-regex sanitizers in
// lib/channel-delivery.ts / lib/fork.ts, which this mirrors).
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/**
 * Complete ANSI escape sequences (OSC/DCS-style strings, CSI, and short
 * escapes). Stripping WHOLE sequences matters: formatTerminalTextForAgent alone
 * removes just the ESC byte, which would leave parameter bytes like "[31m"
 * behind as visible text.
 */
const ANSI_SEQUENCES = new RegExp(
  [
    // OSC/DCS/SOS/PM/APC strings: ESC + one of ] P X ^ _, then a payload up to
    // a BEL or ST (ESC \) terminator — or end-of-input for a dangling one.
    `${ESC}[\\]PX^_][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\|$)`,
    // CSI: ESC [ params (0x30–0x3f, incl. < = > ? DEC private) intermediates
    // (0x20–0x2f) final byte (0x40–0x7e).
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    // Any other escape: ESC + intermediate bytes (0x20–0x2f) + a final byte
    // (0x30–0x7e — covers charset designations like `ESC ( B` and `ESC c`).
    `${ESC}[ -/]*[0-~]`,
  ].join("|"),
  "g"
);

/**
 * Wrap captured terminal text in a fenced Markdown code block. Strips complete
 * ANSI sequences first, then reuses formatTerminalTextForAgent for the C0/DEL
 * strip (keeping tab/newline layout), CRLF→LF normalization, and the
 * surrounding blank-line trim. The fence is one backtick LONGER than the
 * longest backtick run in the body, so a body containing ``` can't close the
 * block early. Returns "" when nothing meaningful is left (empty / whitespace /
 * control-only input) — callers treat that as "nothing to copy". Pure.
 */
export function toMarkdownBlock(text: string, lang?: string): string {
  if (!text) return "";
  const body = formatTerminalTextForAgent(text.replace(ANSI_SEQUENCES, ""));
  if (!body) return "";
  let longestRun = 0;
  for (const run of body.match(/`+/g) ?? []) {
    if (run.length > longestRun) longestRun = run.length;
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  // Keep the info string a single clean token — whitespace/backticks in it
  // would change how renderers parse the fence line.
  const info = (lang ?? "").replace(/[`\s]+/g, "");
  return `${fence}${info}\n${body}\n${fence}`;
}
