// C0 control bytes + DEL, EXCEPT newline (\x0a). The note is typed LITERALLY into
// the agent's TUI via pasteText, so a stray ESC (\x1b) or a bracketed-paste-end
// sequence (\x1b[201~) embedded in untrusted repo line content would break out of
// the paste and inject live keystrokes. Strip them fail-closed (newlines are kept
// so a multi-line note stays multi-line).
const CONTROL_BYTES = /[\x00-\x09\x0b-\x1f\x7f]/g;

/**
 * Format a one-line review note (from the diff viewer) into the message injected
 * into a worker session's input via send-keys (#1-A). Pure + testable. The text is
 * typed literally into the agent's TUI (backend.pasteText, NOT a shell), so the
 * only safety concern is control bytes — stripped here.
 */
export function formatReviewComment(
  file: string,
  line: number | null,
  lineContent: string | null,
  comment: string
): string {
  const safeContent = (lineContent ?? "").replace(CONTROL_BYTES, "");
  const safeComment = comment.replace(CONTROL_BYTES, "");
  const where = line && line > 0 ? `${file} (line ${line})` : file;
  const quoted = safeContent.trim() ? `\n> ${safeContent.trim()}\n` : "\n";
  return `[Stoa] Review note on ${where}:${quoted}\n${safeComment.trim()}`;
}

/**
 * A structured locator for a DOM element picked in the live-preview iframe (#28).
 * NOT a screenshot — a text description an agent can act on: the tag, the nearest
 * stable handle (id / data-testid), a short visible-text snippet, and a compact
 * ancestor path. Every field is a repo-derived / DOM-derived string, so it is
 * treated as UNTRUSTED and sanitized before it reaches the keystroke channel.
 */
export interface PreviewLocator {
  /** Lowercase tag name of the clicked element, e.g. "button". */
  tag: string;
  /** The element's id attribute, if any. */
  id?: string | null;
  /** The element's data-testid attribute, if any (preferred stable handle). */
  testId?: string | null;
  /** A short snippet of the element's visible text content, if any. */
  text?: string | null;
  /** A compact CSS-ish ancestor path, e.g. "main > form.login > button". */
  domPath?: string | null;
  /** The preview URL the picker was pointed at, for context. */
  url?: string | null;
}

/** How many characters of the visible-text snippet survive into the message. */
const PREVIEW_TEXT_MAX = 120;
/** How many characters of the DOM path survive into the message. */
const PREVIEW_DOM_PATH_MAX = 200;

/** Collapse runs of whitespace (incl. newlines/tabs) into single spaces and trim.
 * Pure. Used to flatten multi-line DOM text into a one-line snippet BEFORE the
 * control-byte strip so a snippet never smuggles a newline into the wrapper. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Normalize a raw locator (as received over postMessage from the injected picker,
 * where every field is attacker-influenced repo/DOM content) into a clean, bounded
 * locator. Pure → unit-tested. Strips control bytes, collapses whitespace, caps
 * lengths, lowercases the tag, and drops empties to `null`. `tag` falls back to
 * "element" so the message always names something.
 */
export function normalizeLocator(raw: Partial<PreviewLocator>): PreviewLocator {
  const clean = (v: unknown, max: number): string | null => {
    if (typeof v !== "string") return null;
    const flattened = collapseWhitespace(v).replace(CONTROL_BYTES, "");
    if (!flattened) return null;
    return flattened.length > max ? flattened.slice(0, max) + "…" : flattened;
  };
  const tagRaw = clean(raw.tag, 40);
  return {
    tag: (tagRaw ?? "element").toLowerCase(),
    id: clean(raw.id, 100),
    testId: clean(raw.testId, 100),
    text: clean(raw.text, PREVIEW_TEXT_MAX),
    domPath: clean(raw.domPath, PREVIEW_DOM_PATH_MAX),
    url: clean(raw.url, 300),
  };
}

/** A one-line human handle for a normalized locator, e.g.
 * `<button data-testid="submit">` or `<a> "Sign in"`. Pure. Prefers the most
 * stable identifier available. */
export function describeLocator(loc: PreviewLocator): string {
  if (loc.testId) return `<${loc.tag} data-testid="${loc.testId}">`;
  if (loc.id) return `<${loc.tag} id="${loc.id}">`;
  if (loc.text) return `<${loc.tag}> "${loc.text}"`;
  return `<${loc.tag}>`;
}

/**
 * Build the structured message sent to the worker session for a click-to-comment
 * note from the live preview (#28). Pure → unit-tested. The result is typed
 * literally into the agent's TUI via the SAME send-keys / pasteText path as the
 * diff review note (no new transport), so — like formatReviewComment — the only
 * safety concern is control bytes, already stripped in normalizeLocator and again
 * on the note here. The caller normalizes the locator first (normalizeLocator).
 */
export function formatPreviewComment(input: {
  locator: PreviewLocator;
  note: string;
}): string {
  const loc = input.locator;
  const safeNote = collapseNoteNewlines(input.note).replace(CONTROL_BYTES, "");
  const lines: string[] = [];
  lines.push(`[Stoa] UI note on ${describeLocator(loc)}:`);
  if (loc.url) lines.push(`page: ${loc.url}`);
  if (loc.domPath) lines.push(`path: ${loc.domPath}`);
  if (loc.text && !loc.testId && !loc.id) {
    // text already surfaced in describeLocator when it's the only handle; skip dup
  } else if (loc.text) {
    lines.push(`text: "${loc.text}"`);
  }
  lines.push("");
  lines.push(safeNote.trim());
  return lines.join("\n");
}

/** Keep the note multi-line (newlines are legal keystrokes) but drop a trailing
 * blank run so the message doesn't end with a wall of blank lines. Pure. */
function collapseNoteNewlines(note: string): string {
  return note.replace(/\n{3,}/g, "\n\n");
}
