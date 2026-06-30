/**
 * Auto-steer — policy-driven unblocking of routine prompts.
 *
 * When an agent stops on a routine prompt ("Press Enter to continue", a "❯ 1. Yes"
 * permission menu), Stoa can press Enter for you so a fleet run doesn't stall on a
 * 2am question. This module is the PURE core (no I/O): detect the prompt off the
 * RENDERED screen, classify it, and decide — answer (press Enter) or escalate
 * (leave it visibly waiting). server.ts owns the side effect (the status tick that
 * sends the keystroke through the SessionBackend seam), mirroring rate-limit.ts.
 *
 * SAFETY is the whole design, and the safety is STRUCTURAL, not a denylist:
 *   - We only ever send ENTER, and Enter selects the HIGHLIGHTED (❯) menu option —
 *     so we answer ONLY when the cursor already sits on a single-shot "Yes". We can
 *     never flip the highlight to a "No", and never land on a "Yes, allow all /
 *     don't ask again" (those escalate). For non-menu prompts we accept only the
 *     ones whose default IS the affirmative ("Press Enter to…", "[Y/n]"); a "[y/N]"
 *     (default No) escalates.
 *   - A best-effort DESTRUCTIVE denylist over the WHOLE capture is defense-in-depth
 *     ONLY (it can never be exhaustive) — a match forces escalation even of an
 *     otherwise-answerable prompt. It is deliberately generous (over-escalating a
 *     safe prompt is fine; auto-accepting a dangerous one is not).
 * Detection is always-on; the unattended KEYSTROKE is opt-in via STOA_AUTO_ANSWER=1
 * (mirrors STOA_AUTO_RESUME). Everything fails CLOSED: unsure → escalate.
 * Unit-tested across the matrix.
 */

export type PromptKind =
  | "continue" // non-menu prompt whose default is the affirmative (Press Enter / [Y/n])
  | "affirmative" // a menu whose HIGHLIGHTED option is a single-shot "Yes"
  | "blanket" // highlighted option grants standing permission — escalate
  | "negative" // highlighted "No" / "[y/N]" default — escalate (never flip to Yes)
  | "destructive" // the gated command looks dangerous — escalate
  | "freeform"; // a prompt, but not a known Enter-acceptable shape — escalate

/** A prompt detected on the rendered screen: its class + the matched line. */
export interface PromptState {
  kind: PromptKind;
  /** The decisive line (highlighted option, or the question) — a STABLE signature
   * for the server's once-guard + a human-readable label. */
  line: string;
}

// Any one of these means an interactive prompt is on screen. Superset gate: if
// none match (in the tail) we report no prompt; if one matches we CLASSIFY below.
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
  /waiting for input/i, // also a WAITING_PATTERN — keep the two in sync
  /(?:❯|›|▶)\s*\d+\.\s/, // a highlighted numbered menu option
  /\b\d+\.\s*Yes\b/i,
];

// A highlighted menu option — the line Enter will SELECT. Group 1 = the option
// text after the number. ONLY the real selection glyphs (❯/›/▶) count — NOT the
// ASCII ">", which is also the input-box prompt and a shell redirect (matching it
// would let a half-typed "> 1. yes…" message submit itself on Enter).
const HIGHLIGHT = /(?:❯|›|▶)\s*\d+\.\s*(.+)$/;

// The affirmative is an ALLOWLIST, not a denylist — fail CLOSED. We accept a
// highlighted option ONLY when its WHOLE text is a bare single-shot yes (the real
// Claude Code default is literally "Yes" / "Yes, proceed"). Anything qualified —
// "Yes, allow always", "Yes, without asking", "Yes, and don't ask again", "Trust" —
// is NOT a single-shot and falls through to escalate, no matter what new standing-
// grant phrasing a provider invents.
const SINGLE_SHOT_YES =
  /^(y|yes|ok|okay|sure|allow|approve|accept|confirm|proceed|continue|run it|do it|go ahead)(\s*,?\s*(yes|proceed|continue|and continue|once|now|please|go ahead|run it|do it|this time))*\s*[.!]?$/i;
// Standing-grant phrasings — checked first only to LABEL the escalation as
// "blanket" (the allowlist above already refuses to accept them). Broad on purpose.
const OPT_BLANKET =
  /\b(allow all|all edits|all commands|don'?t ask( me)? again|and don'?t ask|always (allow|approve|accept)|allow always|auto[- ]?approve|from now on|remember (this|my)|for (this|the) session|without (asking|confirm)|no confirmation|accept all|apply to all|every time|for the rest of|bypass|yolo)\b/i;
const OPT_NEGATIVE =
  /\b(no\b|don'?t|do not|cancel|reject|deny|decline|tell (claude|the agent|me)|something else|go back|abort|quit|exit|skip)\b/i;

// The command being approved usually renders near the prompt; scan the WHOLE
// capture (commands can scroll above the prompt window) AND a newline-stripped copy
// (heals terminal line-wrap that splits a token). Deliberately GENEROUS — a false
// positive only escalates, which is safe. NOT exhaustive — defense-in-depth only.
const DESTRUCTIVE = new RegExp(
  [
    "rm\\s+-[rf]",
    "\\bsudo\\b",
    "force[- ]?push",
    "push\\s+--force",
    "--force(-with-lease)?\\b",
    "git\\s+reset\\s+--hard",
    "git\\s+clean\\s+-[a-z]*f",
    "git\\s+branch\\s+-D",
    "DROP\\s+(TABLE|DATABASE|SCHEMA)",
    "DELETE\\s+FROM",
    "TRUNCATE\\b",
    "mkfs\\b",
    "dd\\s+if=",
    ">\\s*/dev/",
    "chmod\\s+-R",
    "chown\\s+-R",
    "\\bnpm\\s+(i|install|add|publish)\\b",
    "\\b(pnpm|yarn|bun)\\s+(add|install|publish)\\b",
    "\\bpip\\s+install\\b",
    "curl\\b[^\\n]*\\|\\s*(sh|bash)",
    "wget\\b[^\\n]*\\|\\s*(sh|bash)",
    "terraform\\s+(destroy|apply)",
    "kubectl\\s+delete",
    "helm\\s+(delete|uninstall)",
    "gh\\s+repo\\s+delete",
    "docker\\s+(rm|rmi|system\\s+prune|volume\\s+rm|.*prune)",
    "git\\s+push\\b[^\\n]*(\\s-f\\b|\\s\\+)", // force via -f / +refspec
    "git\\s+checkout\\s+--\\s", // discard working-tree changes
    "git\\s+stash\\s+(drop|clear)",
    "chmod\\s+[0-7]*7[0-7]{2}", // world-writable/executable
    "/dev/null\\b",
    "rmtree\\b",
    // Windows deletions (this product runs natively on Windows):
    "\\bformat\\s+[a-z]:",
    "Remove-Item\\b",
    "\\brmdir\\b",
    "\\brd\\s+/s",
    "\\bdel\\s+(/[a-z]\\s+)*",
  ].join("|"),
  "i"
);

// Non-menu shapes whose DEFAULT is the affirmative (Enter accepts):
const ENTER_TO_PROCEED = /Press Enter to (continue|confirm|proceed)/i;
const YES_DEFAULT = /\[Y\/n\]/; // capital Y default → Enter = yes
const NO_DEFAULT = /\[y\/N\]/; // capital N default → Enter = no

// A folder/workspace-trust prompt grants the target repo's hooks/settings — an
// escalation primitive, so always leave it for the human even if the cursor is on Yes.
const SENSITIVE =
  /\btrust\b[^\n]{0,80}\b(folder|files|workspace|director|repo)|\bdo you trust\b/i;

// Heal terminal line-wrap: strip a newline AND the padding spaces a terminal
// inserts at the wrap boundary, so a token split across the wrap (e.g.
// "--fo  \nrce") rejoins ("--force") for the denylist scan. Tested raw too.
const healWrap = (screen: string): string =>
  screen.replace(/[ \t]*\r?\n[ \t]*/g, "");

function isDangerous(screen: string): boolean {
  return DESTRUCTIVE.test(screen) || DESTRUCTIVE.test(healWrap(screen));
}

function isSensitive(screen: string): boolean {
  // Whole-capture (the trust question can render above the menu) + wrap-healed.
  return SENSITIVE.test(screen) || SENSITIVE.test(healWrap(screen));
}

/**
 * Detect + classify a prompt on the rendered screen. A LIVE prompt owns the bottom
 * of the screen, so we only look at the last few non-empty lines (a prompt quoted
 * higher up, or in a finished turn's prose, won't trip it). Returns null when no
 * prompt is present. Pure → unit-tested.
 *
 * Menus are classified off the HIGHLIGHTED (❯) option — the one Enter selects — so
 * "answerable" means "the cursor is already on a single-shot Yes". Non-menu prompts
 * are accepted only when their default is the affirmative. A dangerous gated command
 * (whole-capture denylist) forces escalation regardless.
 */
export function detectPrompt(renderedScreen: string): PromptState | null {
  if (!renderedScreen) return null;
  const nonEmpty = renderedScreen
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim());
  if (nonEmpty.length === 0) return null;

  const tail = nonEmpty.slice(-6); // a live prompt is in the last few lines
  const tailText = tail.join("\n");
  if (!PROMPT_HINTS.some((re) => re.test(tailText))) return null;

  const danger = isDangerous(renderedScreen);
  const sensitive = isSensitive(renderedScreen);
  // A standing grant can live in the QUESTION ("Always allow edits in this folder?")
  // with a bare "Yes" option. Scan blanket over the NON-OPTION lines only — NOT the
  // numbered options, because a real Claude Code menu legitimately lists a blanket
  // OPTION ("2. …don't ask again") that must not poison the highlighted single-shot.
  const isOptionLine = (l: string) => /^\s*(?:❯|›|▶)?\s*\d+\.\s/.test(l);
  const questionBlanket = OPT_BLANKET.test(
    tail.filter((l) => !isOptionLine(l)).join("\n")
  );

  // MENU: Enter selects the HIGHLIGHTED option. Classify THAT line — the structural
  // safety. If multiple highlight markers render, the last one wins (the live one).
  const hi = tail
    .map((l) => HIGHLIGHT.exec(l))
    .filter(Boolean)
    .pop();
  if (hi) {
    const opt = hi[1].trim();
    const line = hi[0].trim();
    if (danger) return { kind: "destructive", line };
    if (OPT_BLANKET.test(opt) || questionBlanket) {
      return { kind: "blanket", line };
    }
    if (OPT_NEGATIVE.test(opt)) return { kind: "negative", line };
    // Accept ONLY a bare single-shot yes, and never a folder-trust grant.
    if (SINGLE_SHOT_YES.test(opt) && !sensitive) {
      return { kind: "affirmative", line };
    }
    return { kind: "freeform", line };
  }

  // NON-MENU: a prompt hint with no highlighted option. Accept only an
  // affirmative-default shape, and only when it sits on the last line or two (a
  // live prompt, not prose). Everything else escalates.
  const bottom = tail.slice(-2).join("\n");
  const line = tail[tail.length - 1].trim();
  if (danger) return { kind: "destructive", line };
  if (OPT_BLANKET.test(bottom)) return { kind: "blanket", line };
  if (NO_DEFAULT.test(bottom)) return { kind: "negative", line };
  if (
    (ENTER_TO_PROCEED.test(bottom) || YES_DEFAULT.test(bottom)) &&
    !sensitive
  ) {
    return { kind: "continue", line };
  }
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

/** A stable once-guard signature for a prompt — kind + line with volatile digits
 * collapsed, so a countdown ("auto in 5s" → "3s") doesn't defeat the guard and get
 * Enter re-sent every tick. Used by server.ts to answer each prompt exactly once. */
export function promptSignature(p: PromptState): string {
  return `${p.kind}|${p.line.replace(/\d+/g, "#")}`;
}

/**
 * Whether to RE-ARM auto-answer's once-per-prompt guard for a session this tick.
 * ONLY when the turn has genuinely settled (idle) or the session is gone (dead) —
 * NOT on a transient "running"/spinner flap. The status detector gives busy
 * indicators top priority, so a live prompt that shows any animated element for a
 * single capture reads as "running"; clearing the guard then would let the SAME
 * prompt be answered a SECOND time when it re-reads as "waiting" next tick (a
 * second unattended Enter into a menu the agent may have already advanced).
 */
export function shouldRearmAutoAnswer(status: string): boolean {
  return status === "idle" || status === "dead";
}

/**
 * Whether the queue dispatcher may acknowledge a waiting session (which promotes a
 * SETTLED turn to "idle" so its queued task can dispatch). Never when a real prompt
 * is detected: a finished turn and a permission prompt are both "waiting", and
 * acknowledging a borderline prompt that intermittently fails the waiting-pattern
 * check would flip it to "idle" and paste the queued task into the open dialog.
 */
export function shouldAcknowledgeQueued(
  status: string,
  hasPrompt: boolean
): boolean {
  return status === "waiting" && !hasPrompt;
}

/** Is unattended auto-answer armed? Off by default (STOA_AUTO_ANSWER=1 enables).
 * Read ONCE at startup (server.ts captures it in a const), like autoResumeEnabled. */
export function autoAnswerEnabled(): boolean {
  return process.env.STOA_AUTO_ANSWER === "1";
}

/**
 * Is one-tap push Approve armed? OFF by default (STOA_PUSH_APPROVE=1 enables). The lock-screen
 * Approve presses Enter on a `continue` prompt — a keystroke sent from a notification — so it is
 * gated like every other unattended-keystroke feature; by default Stoa notifications stay purely
 * attention-only. It is a SEPARATE flag from STOA_AUTO_ANSWER (not a reuse) because the two never
 * overlap: when auto-answer is on, an answerable prompt is auto-pressed BEFORE any push fires, so
 * the button would never appear — this flag serves the opposite user, one who wants manual control
 * yet a one-tap Approve from the lock screen. Enforced at BOTH the push-build (the button) and the
 * /respond route (the actual Enter), so a stale notification can't fire when the flag is off.
 */
export function pushApproveEnabled(): boolean {
  return process.env.STOA_PUSH_APPROVE === "1";
}
