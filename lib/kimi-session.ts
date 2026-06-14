import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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
 */

/**
 * Pure: pick the most recent `sessionId` whose `workDir` matches `cwd` from the
 * contents of a kimi-code `session_index.jsonl`. Paths are normalized
 * (backslashes → "/", trailing "/" dropped, lower-cased) before comparison so a
 * Windows pane cwd (`C:\…`) matches the index's forward-slash `workDir`. Later
 * lines win (the index is append-ordered, so the last match is newest).
 * Malformed lines are skipped. Exported for unit tests.
 */
export function parseKimiSessionIndex(
  indexContent: string,
  cwd: string
): string | null {
  const norm = (p: string) =>
    p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const target = norm(cwd);
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
      if (entry.workDir && entry.sessionId && norm(entry.workDir) === target) {
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
