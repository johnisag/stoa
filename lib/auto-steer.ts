/**
 * Auto-steer — policy-driven unblocking of routine prompts.
 *
 * When an agent stops to ask a routine question ("Press Enter to continue", "Do
 * you want to proceed? ❯ 1. Yes"), Stoa can press the key for you so an overnight
 * fleet run doesn't stall on a 2am prompt. This module is the PURE core (no I/O):
 * detect the prompt off the RENDERED screen, classify it, and decide — answer
 * (press Enter to accept) or escalate (leave it visibly waiting for the human).
 * server.ts owns the side effect (the status tick that sends the keystroke through
 * the SessionBackend seam), mirroring the rate-limit auto-resume.
 *
 * SAFETY is the whole design. Detection + surfacing are always-on; the unattended
 * KEYSTROKE is opt-in via STOA_AUTO_ANSWER=1 (mirrors STOA_AUTO_RESUME). And the
 * only key we ever send is ENTER to ACCEPT a prompt whose default is already the
 * safe, affirmative option. We NEVER flip a default-No to Yes, NEVER grant blanket
 * permission ("allow all" / "don't ask again"), and ALWAYS escalate anything whose
 * surrounding text looks destructive (rm -rf, force-push, drop, sudo, install …).
 * Everything fails CLOSED: unsure → escalate. Unit-tested across the matrix.
 */

export type PromptKind =
  | "continue" // Enter accepts (Press Enter to continue; [Y/n] yes-default)
  | "affirmative" // a permission menu whose highlighted default is the single Yes
  | "blanket" // "allow all" / "don't ask again" — escalate, never auto-grant
  | "negative" // [y/N] — the default is No; respect the agent's caution
  | "destructive" // the gated command looks dangerous — escalate
  | "freeform"; // a prompt, but not an Enter-acceptable yes/no — escalate

/** A prompt detected on the rendered screen: its class + the matched line. */
export interface PromptState {
  kind: PromptKind;
  /** The last non-empty rendered line (signature for the once-guard + display). */
  line: string;
}

// Any one of these means an interactive prompt is on screen. Superset gate: if
// none match we report no prompt; if one matches we then CLASSIFY it below.
const PROMPT_HINTS: RegExp[] = [
  /\[y\/n\]/i,
  /Allow\b[^\n]*\?/i,
  /Approve\?/i,
  /Continue\?/i,
  /Proceed\?/i,
  /Press Enter to/i,
  /\(yes\/no\)/i,
  /Do you want to/i,
  /Enter to confirm/i,
  /(?:❯|>)\s*\d\.\s/, // a highlighted numbered menu option
  /\b\d\.\s*Yes\b/i,
];

// The command being approved usually renders just above the prompt, so a recent-
// window scan catches it. Deliberately GENEROUS — prefer escalating a safe prompt
// over auto-accepting a dangerous one. (Word-ish boundaries, case-insensitive.)
const DESTRUCTIVE = new RegExp(
  [
    "rm\\s+-[rf]",
    "\\bsudo\\b",
    "force[- ]?push",
    "push\\s+--force",
    "--force(-with-lease)?\\b",
    "git\\s+reset\\s+--hard",
    "git\\s+clean\\s+-[a-z]*f",
    "DROP\\s+(TABLE|DATABASE)",
    "DELETE\\s+FROM",
    "TRUNCATE\\b",
    "mkfs\\b",
    "dd\\s+if=",
    ">\\s*/dev/",
    "chmod\\s+-R",
    "chown\\s+-R",
    "\\bnpm\\s+(i|install|add)\\b",
    "\\b(pnpm|yarn|bun)\\s+(add|install)\\b",
    "\\bpip\\s+install\\b",
    "curl\\b[^\\n]*\\|\\s*(sh|bash)",
    "wget\\b[^\\n]*\\|\\s*(sh|bash)",
    "\\bformat\\s+c:",
    "Remove-Item\\b",
    "\\brmdir\\b",
  ].join("|"),
  "i"
);

// "allow all" / "yes, and don't ask again" / "always allow" — granting standing
// permission unattended is exactly what a human must decide, so always escalate.
const BLANKET =
  /\b(allow all|yes,?\s*allow all|don'?t ask( me)? again|and don'?t ask|always allow|allow every|trust all|allow all edits|allow all commands)\b/i;

// Enter-acceptable shapes (the default IS the affirmative):
const YES_DEFAULT = /\[Y\/n\]/; // capital Y default → Enter = yes
const NO_DEFAULT = /\[y\/N\]/; // capital N default → Enter = no
const ENTER_TO_PROCEED = /Press Enter to (continue|confirm|proceed)/i;
const HIGHLIGHTED_YES = /(?:❯|>)\s*1\.\s*Yes\b/i; // ❯ 1. Yes (menu default)
const PROCEED_MENU = /\bDo you want to (proceed|continue)\b/i; // + a "1. Yes" option

function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1].trim() : "";
}

/**
 * Detect + classify a prompt on the rendered screen. Scans only the last few
 * lines (a live prompt is the most recent output; old scrollback would
 * false-positive). Returns null when no prompt is present. Pure → unit-tested.
 *
 * Classification precedence is MOST-DANGEROUS-FIRST so a risky prompt can never be
 * mistaken for an answerable one: destructive → blanket → negative-default →
 * affirmative/continue → freeform.
 */
export function detectPrompt(renderedScreen: string): PromptState | null {
  if (!renderedScreen) return null;
  const recent = renderedScreen.split("\n").slice(-8).join("\n");
  if (!PROMPT_HINTS.some((re) => re.test(recent))) return null;

  const line = lastNonEmptyLine(recent);
  // 1. A dangerous-looking gated command → never auto-accept.
  if (DESTRUCTIVE.test(recent)) return { kind: "destructive", line };
  // 2. A blanket / standing-permission grant → never auto-accept.
  if (BLANKET.test(recent)) return { kind: "blanket", line };
  // 3. Default-No prompt → respect the agent's caution (don't flip it to yes).
  if (NO_DEFAULT.test(recent)) return { kind: "negative", line };
  // 4. Enter accepts the affirmative default → answerable.
  if (
    HIGHLIGHTED_YES.test(recent) ||
    (PROCEED_MENU.test(recent) && /\b1\.\s*Yes\b/i.test(recent))
  ) {
    return { kind: "affirmative", line };
  }
  if (ENTER_TO_PROCEED.test(recent) || YES_DEFAULT.test(recent)) {
    return { kind: "continue", line };
  }
  // 5. A prompt, but not a shape where Enter is known to accept → leave it.
  return { kind: "freeform", line };
}

export type AutoAnswerAction = "answer" | "escalate" | "idle";

/**
 * Pure decision for one waiting session each tick. Unit-tested.
 *   idle     — no prompt, or the session isn't actually blocked (status != waiting)
 *   answer   — a routine prompt whose default is the safe affirmative → press Enter
 *   escalate — anything else (blanket / negative / destructive / freeform) → leave
 *              it visibly waiting for the human
 * Requiring status === "waiting" is belt-and-suspenders: the agent is genuinely
 * blocked on input, not merely showing prompt-like text mid-run.
 */
export function nextAutoAnswerAction(input: {
  prompt: PromptState | null;
  status: string;
}): AutoAnswerAction {
  if (!input.prompt || input.status !== "waiting") return "idle";
  if (input.prompt.kind === "continue" || input.prompt.kind === "affirmative") {
    return "answer";
  }
  return "escalate";
}

/** Is unattended auto-answer armed? Off by default (STOA_AUTO_ANSWER=1 enables).
 * Read ONCE at startup (server.ts captures it in a const), like autoResumeEnabled. */
export function autoAnswerEnabled(): boolean {
  return process.env.STOA_AUTO_ANSWER === "1";
}
