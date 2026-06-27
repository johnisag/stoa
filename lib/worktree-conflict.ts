/**
 * Worktree-conflict detection — a cross-session "are two agents about to clobber
 * each other?" check, surfaced as a badge on the session card (amux's footgun
 * guard, item #9).
 *
 * The collision condition in Stoa is precise and computable WITHOUT git I/O: a
 * session's `working_directory` IS the checkout its pty edits, and a worktree
 * session's working_directory is its (unique) worktree path — so two LIVE sessions
 * sharing a normalized working_directory are editing the same files on the same
 * branch, while worktree-isolated sessions self-exempt (their paths never
 * collide). No need to group by `repo::branch` + resolve the default branch
 * (amux's heavier machinery) — a shared directory already implies a shared branch.
 *
 * Known, deliberate gaps (the price of the I/O-free working-dir approach — closing
 * them needs git-root resolution): two sessions in DIFFERENT directories that
 * resolve to the same checkout (a symlink/bind-mount, or a repo root vs a
 * SUBDIRECTORY of it) are not grouped, so that narrower clobber goes unflagged.
 *
 * This is the PURE core (no I/O, no node builtins) so it runs client-side over
 * the live session list the sidebar already holds, and is unit-tested. It returns
 * a plain `Record<id, groupSize>` keyed exactly like the `sessionStatuses` map the
 * sections already thread down, so a card gets a memo-friendly primitive count.
 * The caller passes `homeDir` + `caseInsensitive` (from the server, which knows
 * the OS) so path equality matches the repo's own `normalizePathForCompare`.
 */

/** The only fields the detector needs off a session row. */
export interface ConflictSessionLike {
  id: string;
  working_directory: string;
}

export interface DetectOptions {
  /** When provided, only sessions for which this returns true are counted. A DEAD
   * session (pty exited) isn't editing anything right now, so it can't clobber. */
  isLive?: (id: string) => boolean;
  /** Absolute home dir (from the server) — used to expand a leading "~" so a
   * "~/foo" cwd matches an absolute "/home/me/foo", and to exempt bare $HOME (not
   * a checkout). Omit and a literal "~" is still exempted, but an expanded-home
   * path can't be recognized. */
  homeDir?: string;
  /** Compare paths case-insensitively (Windows). Mirrors lib/platform's
   * normalizePathForCompare, which case-folds on win32 only — so two sessions in
   * `C:\Repo` and `c:\repo` are recognized as the same checkout. */
  caseInsensitive?: boolean;
}

// Non-specific default checkouts to skip even without a homeDir: the literal "~"
// placeholder and an empty value. Grouping these would flag every project-less
// session against every other — noise, not a clobber risk. ($HOME in its EXPANDED
// form is exempted separately, via opts.homeDir.)
const EXEMPT_DIRS = new Set(["", "~", "~/"]);

/**
 * Normalize a working_directory into a comparison key: expand a leading "~" to
 * `homeDir`, unify separators to "/", drop a trailing slash, and (on Windows)
 * lowercase. Pure.
 */
export function normalizeCheckout(dir: string, opts?: DetectOptions): string {
  let d = dir.trim();
  // Expand a leading "~"/"~/"/"~\" to the absolute home dir so the tilde form and
  // the expanded form of the same checkout collapse to one key.
  if (
    opts?.homeDir &&
    (d === "~" || d.startsWith("~/") || d.startsWith("~\\"))
  ) {
    d = opts.homeDir + d.slice(1);
  }
  let key = d.replace(/\\/g, "/").replace(/\/+$/, "");
  if (opts?.caseInsensitive) key = key.toLowerCase();
  return key;
}

/**
 * Map each session that SHARES its working_directory with ≥1 other counted
 * session to the size of that shared group (always ≥2). Sessions with a unique
 * checkout — every worktree session, and any lone session — are absent from the
 * result (so a card reads `conflictCount` as undefined and shows no badge). Dead
 * sessions (per `opts.isLive`), the "~"/empty defaults, and bare $HOME are not
 * counted. Pure → unit-tested.
 */
export function detectSharedCheckouts(
  sessions: ConflictSessionLike[],
  opts?: DetectOptions
): Record<string, number> {
  // The home dir's own comparison key — bare $HOME isn't a checkout to isolate.
  const homeKey = opts?.homeDir ? normalizeCheckout(opts.homeDir, opts) : "";
  // Bucket session ids by normalized checkout.
  const byDir = new Map<string, string[]>();
  for (const s of sessions) {
    if (opts?.isLive && !opts.isLive(s.id)) continue; // dead → can't clobber
    if (EXEMPT_DIRS.has(s.working_directory.trim())) continue;
    const key = normalizeCheckout(s.working_directory, opts);
    if (!key || EXEMPT_DIRS.has(key) || key === homeKey) continue;
    const ids = byDir.get(key);
    if (ids) ids.push(s.id);
    else byDir.set(key, [s.id]);
  }
  const out: Record<string, number> = {};
  for (const ids of byDir.values()) {
    if (ids.length < 2) continue; // a unique checkout is never a conflict
    for (const id of ids) out[id] = ids.length;
  }
  return out;
}
