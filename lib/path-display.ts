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
