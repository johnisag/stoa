/**
 * Pure file:line extraction for the terminal's jump-to-error links (#23).
 *
 * A compiler/test error on screen ("lib/foo.ts:12:5", "C:\repo\bar.tsx(3,7)")
 * becomes a clickable link: the xterm link provider (terminal-init.ts) runs
 * this extractor over each RENDERED buffer line and turns every hit into a
 * link whose activation opens the file at that line (desktop) or inserts the
 * text into the prompt (mobile). CLIENT-SAFE: no node builtins, no
 * lib/platform.ts — path joining comes from lib/path-display.ts.
 *
 * The extractor is deliberately CONSERVATIVE — a false negative costs one
 * manual open, a false positive underlines noise everywhere — so a match
 * requires a real extension and a line number:
 *   - colon form:  path.ext:12  /  path.ext:12:5   (tsc, eslint, vitest, node)
 *   - paren form:  path.ext(12) /  path.ext(12,5)  (tsc under Windows, MSVC)
 * Windows drive prefixes (C:\, C:/), POSIX absolute, and ./ .\ relative paths
 * all match; URLs (scheme://…) and protocol-relative //host tokens do not.
 */

import { joinPath } from "./path-display";

export interface FileLineLink {
  /** The path exactly as written on screen (relative or absolute). */
  path: string;
  /** 1-based line number. */
  line: number;
  /** 0-based char offsets of the WHOLE clickable range (path + line part). */
  start: number;
  end: number;
}

// Path token: optional Windows drive prefix, then any run of non-separator
// "path-ish" chars ending in a dot-extension that starts with a letter (kills
// version strings like "v1.2.3:4" and timestamps like "12:30:45"). Colon is
// excluded from the token so the trailing :line stays unambiguous; parens are
// excluded so the paren form stays unambiguous (a "Program Files (x86)" path
// is an accepted false negative). Quotes/backticks are excluded so a quoted
// path's closing quote never rides into the token.
const LINK_RE =
  /((?:[A-Za-z]:[\\/])?[^\s:()[\]'"`]*?\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d{1,6})(?::\d{1,6})?|\((\d{1,6})(?:,\d{1,6})?\))/g;

/** Every file:line hit in one rendered terminal line, left to right. */
export function extractFileLineLinks(text: string): FileLineLink[] {
  const out: FileLineLink[] = [];
  if (!text || text.length > 4096) return out;
  for (const m of text.matchAll(LINK_RE)) {
    const path = m[1];
    const line = parseInt(m[2] ?? m[3], 10);
    if (!Number.isFinite(line) || line < 1) continue;
    if (path.length > 512) continue;
    // URL guards: the drive-prefix alternative can latch onto a scheme's tail
    // ("https://x.com/a.ts" → drive-ish "s://x.com/a.ts"; "file:///c/a.ts" →
    // "e:///c/a.ts"), and a scheme-less token can look protocol-relative.
    if (path.includes("://") || path.startsWith("//")) continue;
    // A real path never starts mid-word: reject when the preceding char is a
    // word/dot/dash (we latched onto the tail of a larger token).
    const before = m.index > 0 ? text[m.index - 1] : "";
    if (/[A-Za-z0-9_.-]/.test(before)) continue;
    out.push({ path, line, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Whether a screen path is absolute on ANY platform (drive, POSIX, UNC). */
export function isAbsoluteScreenPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\");
}

/**
 * The path to actually open for a clicked link: absolute paths pass through
 * untouched; relative ones are joined onto the session's working directory
 * (the compiler's cwd for the output we're reading). No fs access — the
 * files/content route re-validates against the sandbox roots server-side.
 */
export function resolveLinkTarget(
  path: string,
  cwd: string | null | undefined
): string {
  if (isAbsoluteScreenPath(path) || !cwd) return path;
  return joinPath(cwd, path);
}
