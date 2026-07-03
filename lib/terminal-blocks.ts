/**
 * Prompt-boundary navigation over the CAPTURED terminal buffer (Roadmap #53).
 *
 * A PURE, DOM-free parser that turns the rendered terminal screen + scrollback
 * (the same line array `capture()` / the select-mode overlay reads off the xterm
 * buffer) into a list of "command blocks" — Warp-style ranges delimited by shell
 * prompts or agent-turn boundaries. It powers jump-to-prev/next-block navigation
 * and the sticky "current block" header, WITHOUT any shell OSC 133 integration:
 * a ~80% heuristic solution over what's already on screen.
 *
 * Design notes:
 * - Input is the array of RENDERED lines (`line.translateToString(true)` per row,
 *   trailing blanks trimmed), NOT the raw byte stream — a spinner overwrites its
 *   line in place, so only the rendered screen is stable (same rule the status
 *   detector follows).
 * - A "boundary" is the FIRST line of a new block. Everything from one boundary
 *   up to (but not including) the next is one block; its command line becomes the
 *   label. Output blocks are contiguous and cover [0, lines.length).
 * - Heuristics only — deliberately conservative. Prefer missing a boundary over
 *   inventing one mid-output (a false split is more jarring for navigation than a
 *   slightly long block). Tune against real transcripts; keep it agent-agnostic.
 */

/** A detected command block: a half-open line range [startLine, endLine]. */
export interface TerminalBlock {
  /** 0-based index of the block's first line (its boundary line). */
  startLine: number;
  /**
   * 0-based index of the block's LAST line (inclusive). The next block starts at
   * endLine + 1; the final block's endLine is the last line of the buffer.
   */
  endLine: number;
  /**
   * Short human-readable label for the block — the typed command (shell) or the
   * user's message / a turn marker (agent), else a generic fallback. Never empty.
   */
  label: string;
  /** How the boundary was recognized (drives the header icon / future styling). */
  kind: TerminalBlockKind;
}

export type TerminalBlockKind = "shell" | "agent" | "start";

/**
 * A shell prompt line: some leading context (user@host, a path, git branch, …),
 * then a prompt sigil, a single space, and the typed command. The whole trick is
 * telling a real prompt from OUTPUT that merely contains a sigil — critical here
 * because Stoa's primary surface is markdown-heavy AI-agent output, which is full
 * of `# headings`, `> quotes`, ` > ` redirects, and ` % ` / ` $ ` in prose. An
 * over-eager sigil match shreds one agent turn into dozens of bogus "commands".
 * So the sigils are split by how ambiguous they are, matched on the FIRST
 * qualifying position so a command containing a redirect (`$ cat a > b`) stays
 * ONE block:
 *
 *   (1) COLUMN-0 `$` / `%` — a bare `$ ` or `% ` at the very start of the line is
 *       a strong bash/zsh prompt. `#` and `>` are EXCLUDED from this bare form:
 *       a leading `# ` is far more often a markdown H1 and a leading `> ` a
 *       blockquote/diff-quote than a bare root/continuation prompt (those render
 *       glued to a host/path, caught by (3)).
 *   (2) DEDICATED GLYPH `❯` / `➜` — starship/pure/oh-my-zsh. These never occur in
 *       prose, so one preceded by start-or-whitespace is a safe prompt even
 *       mid-line (`~/proj ❯ cmd`).
 *   (3) GLUED PS1 — the sigil hugs a prompt-prefix TOKEN carrying a path/host
 *       marker (`@ ~ \`) with NO intervening space: `user@host:~/proj$ cmd`,
 *       `PS C:\proj> cmd`, `root@box:/# cmd`. The marker distinguishes a real
 *       prompt from a word ending in a sigil. `:` is DELIBERATELY NOT a marker:
 *       it is pervasive in prose (`http://host:3000> ready`, `ratio 16:9% up`,
 *       `Map<K:V> keyed`, `[12:00:00Z]> done`) and would re-open the round-1
 *       over-split — every real prompt that has a `:` also has an `@`/`~`/`\`,
 *       so dropping `:` loses no real prompt. Includes `>` so `C:\path>` matches.
 *   (4) BRACKET PS1 — the Fedora/RHEL/Arch default `[user@host cwd]$ cmd`, at
 *       column 0, with a `@` inside the brackets (so a plain `[note]$` / a
 *       timestamp `[..:..]>` in prose can't match).
 *
 * KNOWN MISSES (accepted — "prefer missing a boundary over inventing one"): any
 * prompt whose sigil is SPACE-SEPARATED from its prefix — macOS zsh `cwd % cmd`
 * (indistinguishable from `50 % off` prose), Git Bash / Raspberry Pi OS
 * `…MINGW64 ~/proj $` / `pi@host:~ $` (space before `$`), the classic
 * `host:cwd user$`, and a marker-less default PS1 (`bash-5.1$`, `host%`). Catching
 * these safely would re-open the round-1 prose over-split. The agent-turn box (the
 * headline surface) is unaffected.
 */
// Capture group 1 in each is the typed command (may be empty). Numbered — not
// named — groups because the tsconfig target (ES2017) predates named groups.
const SHELL_PROMPT_COL0_RE = /^[$%]\s(.*)$/u;
const SHELL_PROMPT_GLYPH_RE = /(?:^|\s)[❯➜]\s(.*)$/u;
// The `(?!<)` guard rejects an angle-bracket token as the prompt prefix, so an
// `<user@host.tld>` email (git author lines, `Co-Authored-By:` / `Signed-off-by:`
// trailers, package.json author fields — ubiquitous in agent output) can't be read
// as an `@`-marked, `>`-sigil'd glued prompt. A real prompt's `>`-token is a drive
// path (`C:\proj>`), never `<addr>`.
const SHELL_PROMPT_GLUED_RE = /(?:^|\s)(?!<)[^\s]*[@~\\][^\s]*[$#%>]\s(.*)$/u;
const SHELL_PROMPT_BRACKET_RE = /^\[[^\]]*@[^\]]*\]\s*[$#%]\s(.*)$/u;

/** Match a shell prompt line, returning the typed command (may be ""), or null. */
function matchShellPrompt(raw: string): string | null {
  const col0 = SHELL_PROMPT_COL0_RE.exec(raw);
  if (col0) return col0[1] ?? "";
  const glyph = SHELL_PROMPT_GLYPH_RE.exec(raw);
  if (glyph) return glyph[1] ?? "";
  const glued = SHELL_PROMPT_GLUED_RE.exec(raw);
  if (glued) return glued[1] ?? "";
  const bracket = SHELL_PROMPT_BRACKET_RE.exec(raw);
  if (bracket) return bracket[1] ?? "";
  return null;
}

/**
 * An EMPTY prompt at end-of-line — awaiting input, its trailing space trimmed off
 * by translateToString, so the sigil is the last visible char. Two safe shapes,
 * chosen so ordinary output ending in a glyph (`it costs 5%`, `fix TODO #`,
 * `<div>`) never matches:
 *   (a) The whole trimmed line, or its last space-separated token, IS a dedicated
 *       prompt glyph `❯` / `➜` — these never appear in prose, so a lone one is a
 *       prompt (`❯`, `~/proj ❯`).
 *   (b) The last token GLUES a sigil (`$ # % > ❯ ➜`) onto a prompt-prefix marker
 *       (`@ ~ \`) with no intervening space (`user@host:~$`, `C:\proj%`,
 *       `PS C:\proj>`) — the marker is what separates a real prompt from a word
 *       that ends in a sigil, so `>` is safe HERE (unlike a lone `>`) because it
 *       still requires the marker (this catches the empty Windows pwsh prompt).
 *       `:` is not a marker (pervasive in prose — see the glued rule above).
 * A LONE `>` / `$` / `#` / `%` (no marker) is never an empty prompt — too common
 * as a redirect / heading / prose tail. Pure + covered by classifyBoundaryLine tests.
 */
const EMPTY_PROMPT_SIGILS = new Set(["$", "#", "%", ">", "❯", "➜"]);
const DEDICATED_PROMPT_GLYPHS = new Set(["❯", "➜"]);
function isBareEmptyPrompt(line: string): boolean {
  const trimmed = line.replace(/\s+$/u, "");
  const sigil = trimmed.slice(-1);
  if (!EMPTY_PROMPT_SIGILS.has(sigil)) return false;
  // The last whitespace-delimited token, e.g. "user@host:~$" or "❯".
  const lastSpace = trimmed.lastIndexOf(" ");
  const token = lastSpace === -1 ? trimmed : trimmed.slice(lastSpace + 1);
  // An angle-bracket token is never a prompt — it's an <user@host> email tail
  // (git author / Co-Authored-By lines) whose `@` + trailing `>` would otherwise
  // read as a glued prompt. A real prompt token (C:\proj>) never starts with `<`.
  if (token.startsWith("<")) return false;
  // (a) A lone dedicated prompt glyph is a prompt even after a space ("~ ❯").
  if (token === sigil) return DEDICATED_PROMPT_GLYPHS.has(sigil);
  // (b) Any sigil GLUED onto a prompt-prefix marker in the same token.
  return /[@~\\]/u.test(token.slice(0, -1));
}

/**
 * The Claude Code / Codex user-input box: the prompt line inside the rounded box
 * renders as a VERTICAL box border, some padding, then "> " and the typed
 * message: `│ > run the tests            │`. Requiring the leading vertical
 * border is what tells this agent-turn boundary apart from a markdown blockquote
 * or diff-quote (`> text` with NO box) — which are pervasive in agent output and
 * must NOT open a new block. A bare `> ` with no border is therefore deliberately
 * NOT an agent boundary.
 */
const AGENT_BOX_PROMPT_RE = /^\s*[│┃╎╏┆┇┊┋]\s*>\s(.*)$/u;

/** Trailing box-border chrome (right edge of the input box) + its padding. */
const TRAILING_BOX_RE = /[\s│┃╎╏┆┇┊┋╭╮╰╯─━]+$/u;

/** Collapse internal runs of whitespace and trim — for a tidy one-line label. */
function tidyLabel(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

/** Truncate a label to a sane header width, adding an ellipsis when clipped. */
export function truncateLabel(label: string, max = 80): string {
  if (label.length <= max) return label;
  // Reserve one char for the ellipsis; guard tiny max values.
  const keep = Math.max(0, max - 1);
  return label.slice(0, keep) + "…";
}

/**
 * Classify a single rendered line as a block boundary, or null if it's interior
 * output. Pure and side-effect free; exported for focused unit tests.
 */
export function classifyBoundaryLine(
  raw: string
): { kind: TerminalBlockKind; label: string } | null {
  // Agent input box first: a vertical box border + "> " prompt. Checked before
  // the shell sigils because a boxed "> " is the specific agent-turn signal; a
  // bare "> " (no box) is NOT a boundary (markdown quote / redirect on the
  // primary agent-output surface).
  const agent = AGENT_BOX_PROMPT_RE.exec(raw);
  if (agent) {
    // Drop the box's RIGHT border + padding from the label (│ ... │ → the text).
    const inner = (agent[1] ?? "").replace(TRAILING_BOX_RE, "");
    const cmd = tidyLabel(inner);
    return { kind: "agent", label: cmd || "(prompt)" };
  }

  // Shell prompt: a line with a "<sigil> [command]". Box chars are irrelevant
  // here (a real shell line has none), so match against the raw line.
  const shellCmd = matchShellPrompt(raw);
  if (shellCmd !== null) {
    const cmd = tidyLabel(shellCmd);
    return { kind: "shell", label: cmd || "(prompt)" };
  }

  // Empty prompt at end of line (no command typed yet).
  if (isBareEmptyPrompt(raw)) {
    return { kind: "shell", label: "(prompt)" };
  }

  return null;
}

/**
 * Parse rendered terminal lines into contiguous command blocks.
 *
 * @param lines rendered screen+scrollback rows, top to bottom (already right-
 *   trimmed, as `translateToString(true)` produces). A trailing run of blank
 *   lines (the cursor parked below the last output) is fine — blanks never open a
 *   block, they fold into the preceding one.
 * @returns blocks in top-to-bottom order, contiguous and covering every input
 *   line. An all-blank or empty input yields a single "start" block (or none for
 *   a truly empty array) so callers always have a valid current block.
 */
export function parseTerminalBlocks(lines: readonly string[]): TerminalBlock[] {
  if (lines.length === 0) return [];

  // Find every boundary line (its index + how it was recognized + its label).
  const boundaries: {
    index: number;
    kind: TerminalBlockKind;
    label: string;
  }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const hit = classifyBoundaryLine(lines[i]);
    if (hit) boundaries.push({ index: i, kind: hit.kind, label: hit.label });
  }

  // No prompt/turn boundary anywhere → the whole buffer is one "start" block.
  // (Common for a full-screen TUI with no prompt line, or pure output.)
  if (boundaries.length === 0) {
    return [
      {
        startLine: 0,
        endLine: lines.length - 1,
        label: "Output",
        kind: "start",
      },
    ];
  }

  const blocks: TerminalBlock[] = [];

  // A leading block for anything ABOVE the first boundary (banner / prior output
  // that scrolled in) so the range stays contiguous from line 0. Skipped when the
  // first boundary IS line 0.
  if (boundaries[0].index > 0) {
    blocks.push({
      startLine: 0,
      endLine: boundaries[0].index - 1,
      label: "Output",
      kind: "start",
    });
  }

  for (let b = 0; b < boundaries.length; b++) {
    const cur = boundaries[b];
    const next = boundaries[b + 1];
    const endLine = next ? next.index - 1 : lines.length - 1;
    blocks.push({
      startLine: cur.index,
      endLine,
      label: cur.label,
      kind: cur.kind,
    });
  }

  return blocks;
}

/**
 * The index of the block that CONTAINS a given line (e.g. the top visible row, so
 * the sticky header names the block you're scrolled into). Returns the last block
 * whose range covers the line; clamps to the ends for out-of-range input. -1 only
 * when there are no blocks (empty buffer).
 */
export function blockIndexForLine(
  blocks: readonly TerminalBlock[],
  line: number
): number {
  if (blocks.length === 0) return -1;
  for (let i = 0; i < blocks.length; i++) {
    if (line >= blocks[i].startLine && line <= blocks[i].endLine) return i;
  }
  // Out of range: clamp (before the first block → 0, past the last → last).
  return line < blocks[0].startLine ? 0 : blocks.length - 1;
}

/**
 * The target scroll line for jumping one block in `direction` from the block that
 * currently contains `fromLine`. +1 = next block's start, -1 = previous block's
 * start. Returns null when there's nowhere to go (already at the first block going
 * up, or the last going down, or no blocks) so the caller can no-op / bump.
 */
export function nextBlockLine(
  blocks: readonly TerminalBlock[],
  fromLine: number,
  direction: 1 | -1
): number | null {
  if (blocks.length === 0) return null;
  const cur = blockIndexForLine(blocks, fromLine);
  const target = cur + direction;
  if (target < 0 || target >= blocks.length) return null;
  return blocks[target].startLine;
}
