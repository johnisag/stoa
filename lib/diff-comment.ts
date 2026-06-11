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
