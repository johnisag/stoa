/** Basename of a path, tolerant of both "/" and "\\" separators (display only). */
export function baseName(p: string): string {
  if (!p) return p;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
/** Dirname of a path, separator-agnostic (display only). */
export function dirName(p: string): string {
  if (!p) return p;
  const parts = p.split(/[\\/]/);
  parts.pop();
  return parts.join("/") || p;
}

/**
 * Path of `absPath` relative to `basePath`, using forward slashes (the form
 * agents/repos expect, cross-platform). Tolerant of "/" and "\\" and a trailing
 * separator on the base. Returns the basename if the two are equal, and the
 * original path unchanged if it isn't under the base. Display/clipboard only.
 */
export function relativePath(absPath: string, basePath: string): string {
  if (!absPath) return absPath;
  const a = absPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const b = basePath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!b) return a;
  if (a === b) return baseName(absPath);
  if (a.startsWith(b + "/")) return a.slice(b.length + 1);
  return absPath;
}

/**
 * Format one or more paths for injection into an agent's prompt. Normalizes to
 * forward slashes (the form agents/repos expect, cross-platform), double-quotes
 * any path containing whitespace so the agent reads it as a single token, joins
 * multiple with a single space, and appends a trailing space so the cursor lands
 * ready for the next word. Empty/blank entries are dropped. Display-side only —
 * this is text typed into a prompt, not a shell argv.
 */
export function formatPathsForAgent(paths: string | string[]): string {
  const list = (Array.isArray(paths) ? paths : [paths])
    // Strip C0 control chars + DEL FIRST: a filename can legally contain a raw
    // newline or ESC, and injected verbatim into the pty that's a keystroke
    // (Enter, or a bracketed-paste escape) — a keystroke-injection vector that
    // quoting does NOT neutralize. Then normalize separators to forward slashes.
    .map((p) => p.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\\/g, "/"))
    .filter((p) => p.trim() !== "");
  if (list.length === 0) return "";
  const quoted = list.map((p) => (/\s/.test(p) ? `"${p}"` : p));
  return quoted.join(" ") + " ";
}

/**
 * Prepare arbitrary captured terminal text (e.g. a selected stack trace) for
 * injection into an agent's prompt. Strips C0 control chars + DEL — injected
 * verbatim into the pty those are keystrokes (Enter, ESC, bracketed-paste
 * escapes), a keystroke-injection vector — but KEEPS tab and newline, which are
 * legitimate layout in captured output and ride in safely as ONE bracketed
 * paste. Normalizes CRLF / lone CR to LF, trims surrounding whitespace / blank
 * lines, and returns "" when nothing meaningful is left. Display-side only —
 * this is text typed into a prompt, not a shell argv.
 */
export function formatTerminalTextForAgent(text: string): string {
  if (!text) return "";
  return (
    text
      .replace(/\x0d\x0a?/g, "\x0a") // normalize CRLF / lone CR to LF first
      // Strip C0 controls + DEL but KEEP tab (\x09) and newline (\x0a), so the
      // captured layout survives injection as a single bracketed paste.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      // Trim surrounding whitespace / blank lines.
      .replace(/^\s+|\s+$/g, "")
  );
}
