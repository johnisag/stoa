import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import {
  findClaudeProjectDir,
  claudeProjectDirName,
  expandHome,
} from "./platform";

/**
 * Read a Claude Code session's on-disk JSONL transcript (the file Stoa already
 * mines for /summarize and cost accounting), or null when it can't be read.
 *
 * The single place that resolves `~/.claude/projects/<encoded-cwd>/<id>.jsonl`,
 * shared by cost accounting and cross-session output search so the path logic
 * (and its path-traversal guard) lives in exactly one spot.
 *
 * `claudeSessionId` is interpolated into the path and can originate from a stored
 * or POSTed field, so reject anything that isn't a plain id token before touching
 * the filesystem — that keeps it inside ~/.claude/projects (no `../` escape).
 * Cross-platform: `os.homedir()` + the platform path helpers, never a hardcoded
 * separator or `process.env.HOME`.
 */
export async function readClaudeTranscriptRaw(
  cwd: string,
  claudeSessionId: string
): Promise<string | null> {
  const path = resolveClaudeTranscriptPath(cwd, claudeSessionId);
  if (!path) return null;
  try {
    // readFile throws ENOENT if it's missing → caught below (no existsSync race).
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Resolve the absolute path of a Claude session's JSONL transcript, or null when
 * the id is unsafe. Same path-traversal guard as the reader: `claudeSessionId` is
 * interpolated into the path and can come from a stored/POSTed field, so reject
 * anything that isn't a plain id token BEFORE building the path (keeps it inside
 * ~/.claude/projects — no `../` escape). Does a couple of cheap stat/dir lookups to
 * locate the project dir but NO transcript read, so the cost cache (#18) can call
 * it on its hot path to key + stat the file without paying the parse.
 */
export function resolveClaudeTranscriptPath(
  cwd: string,
  claudeSessionId: string
): string | null {
  if (!/^[\w-]+$/.test(claudeSessionId)) return null;
  const expanded = expandHome(cwd);
  const projectDir =
    findClaudeProjectDir(expanded) ||
    join(homedir(), ".claude", "projects", claudeProjectDirName(expanded));
  return join(projectDir, `${claudeSessionId}.jsonl`);
}
