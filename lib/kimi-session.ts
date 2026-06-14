import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { normalizePathForCompare } from "./platform";

/**
 * Kimi Code resume-id resolution.
 *
 * Kimi Code (Moonshot AI) writes its sessions to disk under `~/.kimi-code`, and
 * records each one in `~/.kimi-code/session_index.jsonl` — one JSON object per
 * line, e.g.:
 *
 *   {"sessionId":"session_<uuid>","sessionDir":"…","workDir":"C:/my-projects/x"}
 *
 * So — unlike Hermes (which only prints its id in the startup banner) — we can
 * resolve the resume id straight from disk, the same way Stoa resolves Claude's
 * id from its on-disk project files. The captured id is passed back as
 * `--session <id>` when the session is respawned.
 *
 * This on-disk index is the FALLBACK source. The PRIMARY source is Kimi Code's
 * per-session startup banner ("Session: session_<uuid>"), captured from the
 * rendered screen by the status detector (see KIMI_SESSION_ID_RE) — being
 * per-session, the banner disambiguates two sessions sharing a cwd. This index
 * (keyed only by `workDir`) is consulted only when the banner already scrolled
 * off (e.g. attaching to an already-running session); in that fallback case two
 * PLAIN sessions sharing an *exact* working_directory could resolve to the same
 * (newest) id. Worktree / distinct-cwd sessions are unaffected either way.
 */

/**
 * Canonicalize a path for comparison, the same way the rest of the repo does
 * (cf. lib/worktrees `normalizeWorktreePath`): collapse "." / ".." and
 * separators via `path.normalize`, then forward-slash + trailing-slash strip +
 * win32-only case-fold via `normalizePathForCompare`. Stays case-SENSITIVE on
 * POSIX (where two dirs differing only in case are genuinely distinct).
 */
function canonPath(p: string): string {
  return normalizePathForCompare(path.normalize(p));
}

/**
 * Pure: pick the most recent `sessionId` whose `workDir` matches `cwd` from the
 * contents of a kimi-code `session_index.jsonl`. Both sides are run through
 * `normalize` (default: the canonical path compare) before comparison so a
 * Windows-backslash / non-canonical (`..`) / win32-cased pane cwd still matches
 * the index's recorded absolute workDir. Later lines win (the index is
 * append-ordered, so the last match is newest). Malformed lines are skipped.
 * The `normalize` seam is injectable so the matching logic can be unit-tested
 * deterministically across the 3-OS matrix.
 */
export function parseKimiSessionIndex(
  indexContent: string,
  cwd: string,
  normalize: (p: string) => string = canonPath
): string | null {
  const target = normalize(cwd);
  if (!target) return null;

  let found: string | null = null;
  for (const line of indexContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as {
        sessionId?: string;
        workDir?: string;
      };
      if (
        entry.workDir &&
        entry.sessionId &&
        normalize(entry.workDir) === target
      ) {
        found = entry.sessionId;
      }
    } catch {
      // Skip a malformed line rather than failing the whole resolution.
    }
  }
  return found;
}

/**
 * Resolve Kimi Code's resume session id for `cwd` by reading its on-disk session
 * index (`~/.kimi-code/session_index.jsonl`). Returns null when the index is
 * missing/unreadable or has no session for that working directory. Server-only
 * (touches the filesystem).
 */
export function getKimiSessionIdFromFiles(cwd: string): string | null {
  try {
    const indexPath = path.join(
      os.homedir(),
      ".kimi-code",
      "session_index.jsonl"
    );
    if (!fs.existsSync(indexPath)) return null;
    return parseKimiSessionIndex(fs.readFileSync(indexPath, "utf-8"), cwd);
  } catch {
    return null;
  }
}
