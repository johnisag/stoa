/**
 * Client-safe multi-repo stage/unstage fan-out.
 *
 * Kept separate from `multi-repo-git.ts` ON PURPOSE: that module's
 * `getMultiRepoGitStatus` pulls in `git-status` → `platform` → node builtins, so
 * value-importing it from a client component (GitPanel/GitDrawer) would drag
 * those into the browser bundle and break the build. This file imports only the
 * `MultiRepoGitFile` *type* (erased at compile time), so it is safe to import
 * from client components.
 */

import type { MultiRepoGitFile } from "./multi-repo-git";

/**
 * Group files by their `repoPath` into explicit per-repo file lists. Pure — the
 * unit-testable core of the multi-repo stage/unstage fan-out below.
 */
export function groupFilePathsByRepoPath(
  files: MultiRepoGitFile[]
): Map<string, string[]> {
  const byRepo = new Map<string, string[]>();
  for (const f of files) {
    const existing = byRepo.get(f.repoPath) ?? [];
    existing.push(f.path);
    byRepo.set(f.repoPath, existing);
  }
  return byRepo;
}

/**
 * Stage (or unstage) every given file across a multi-repo workspace. The
 * workspace root isn't a single git repo, so a single mutation against the
 * primary repo would silently ignore the others — we must fan out one POST per
 * repo with an explicit file list. Shared by GitPanel and GitDrawer; the caller
 * is responsible for invalidating its query cache afterwards.
 */
export async function stageAllAcrossRepos(
  files: MultiRepoGitFile[],
  endpoint: "stage" | "unstage"
): Promise<unknown> {
  const byRepo = Array.from(groupFilePathsByRepoPath(files).entries());
  // Fan out one POST per repo, then await all before inspecting results so a
  // single per-repo failure (e.g. a git index.lock yielding a 400/500) can't be
  // silently swallowed: a fulfilled Response with `res.ok === false` is still a
  // failure. We surface it by throwing — matching the single-repo mutations,
  // which throw on `data.error` — so the caller (GitPanel/GitDrawer) can react.
  const responses = await Promise.all(
    byRepo.map(([path, repoFiles]) =>
      fetch(`/api/git/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, files: repoFiles }),
      })
    )
  );
  const failed = byRepo
    .filter((_entry, i) => !responses[i].ok)
    .map(([path]) => path);
  if (failed.length > 0) {
    throw new Error(
      `Failed to ${endpoint} ${failed.length} of ${byRepo.length} repo(s): ${failed.join(", ")}`
    );
  }
  return responses;
}
