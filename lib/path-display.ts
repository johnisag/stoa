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
