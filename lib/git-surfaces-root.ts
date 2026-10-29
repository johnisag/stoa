/**
 * Resolve the directory the GIT surfaces (panel/drawer + per-file actions)
 * must operate from, given the /api/git/root result for the Files root (null
 * when the Files root is not in a repo, or its repo root is outside the
 * workspace).
 *
 * Pure on purpose (node-env testable). The rules:
 * - Git porcelain paths and per-file pathspecs are REPO-ROOT relative — even
 *   when git runs from a subdirectory — so whenever the check resolves a repo
 *   root, THAT is the anchor. Joining repo-relative paths against a subdir
 *   cwd produces nonexistent paths (and `git diff -- <path>` from a subdir
 *   matches nothing), so a subdirectory live cwd must NOT be the anchor.
 * - A live cwd that is not inside a repo keeps git on the session's stored
 *   working directory (a non-repo cwd would 400 every git route) — the Files
 *   view still follows the live cwd; only git stays behind.
 * - While the resolution is loading, fall back to the Files root so the panel
 *   behaves exactly as it did before the resolution existed.
 */
export function resolveGitSurfacesRoot(
  repoRoot: string | null | undefined,
  filesRoot: string | null | undefined,
  storedWorkingDirectory: string | null | undefined
): string | null {
  const root = filesRoot ?? null;
  if (repoRoot === undefined) return root;
  if (repoRoot === null) return storedWorkingDirectory ?? root;
  return repoRoot;
}

/** Whether `p` is `root` or inside it ("/" and "\\" tolerant). Pure. */
export function isWithinRoot(p: string, root: string): boolean {
  const a = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const b = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return a === b || a.startsWith(b + "/");
}
