/**
 * Cross-platform helpers.
 *
 * Centralizes every OS-specific assumption so the rest of the codebase can stay
 * platform-neutral. Prefer these over reading process.env.HOME, hardcoding
 * "/tmp", building paths with "/", or shelling out to `which`/`lsof`.
 *
 * Part of the native-Windows migration (see migration-plan.md, Phase 3).
 */

import os from "os";
import path from "path";
import net from "net";
import { existsSync, readdirSync } from "fs";
import { execFileSync } from "child_process";

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";

/** The user's home directory. Use instead of process.env.HOME (unset on Windows). */
export function homeDir(): string {
  return os.homedir();
}

/** The OS temp directory. Use instead of a hardcoded "/tmp". */
export function tmpDir(): string {
  return os.tmpdir();
}

/**
 * Expand a leading "~" to the home directory, cross-platform.
 * Returns non-tilde paths unchanged. Handles "~", "~/x", and "~\x".
 */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return homeDir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(homeDir(), p.slice(2));
  }
  return p;
}

/**
 * The basename of a path, tolerant of either separator regardless of platform.
 * Use for display instead of `p.split("/").pop()`.
 */
export function baseName(p: string): string {
  if (!p) return p;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * Resolve the interactive shell for a user-facing terminal pane.
 * Windows: prefer PowerShell 7 (pwsh), then Windows PowerShell, then cmd.
 * POSIX: $SHELL, then a sensible default.
 */
export function defaultInteractiveShell(): string {
  if (isWindows) {
    return resolveBinary("pwsh") || process.env.ComSpec || "powershell.exe";
  }
  return process.env.SHELL || "/bin/bash";
}

/**
 * Locate an executable on PATH, cross-platform (`where` on Windows, `which`
 * elsewhere). Returns the first match, or null if not found.
 * On Windows this resolves .cmd/.exe/.ps1 shims via PATHEXT.
 */
export function resolveBinary(name: string): string | null {
  try {
    const finder = isWindows ? "where" : "which";
    const out = execFileSync(finder, [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    if (isWindows) {
      // `where` lists every match. npm-installed CLIs ship BOTH an extensionless
      // shell script (for Git Bash) and a .cmd shim — and the shell script often
      // sorts first. Windows/ConPTY can't spawn the extensionless script, so
      // prefer a PATHEXT-executable variant (.cmd/.exe/.bat/.com).
      const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      const executable = lines.find((l) =>
        exts.some((e) => l.toLowerCase().endsWith(e))
      );
      return executable || lines[0];
    }
    return lines[0];
  } catch {
    return null;
  }
}

/**
 * Encode a working directory into Claude Code's on-disk project-dir name.
 *
 * Claude flattens the cwd into a single folder under ~/.claude/projects/ by
 * replacing path separators, ":" AND "." (and other non-word chars) with "-".
 * Verified on disk:
 *   C:\my-projects\stoa  ->  c--my-projects-stoa
 *   a path segment like ".test" contributes an extra "-" (the dot).
 * Earlier versions only replaced "/" (then "/:"), so any path containing a dot
 * (e.g. C:\src\my.app, ~/.config) never matched and session-id/resume/summarize
 * silently failed. findClaudeProjectDir() also scans case-insensitively, so a
 * lowercased vs preserved-case drive letter still resolves.
 */
export function claudeProjectDirName(cwd: string): string {
  const normalized = cwd
    .replace(/\\/g, "/")
    .replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  // Replace separators, colon, and dot with "-" (Claude's encoding).
  return normalized.replace(/[/:.]/g, "-");
}

/**
 * Resolve the actual Claude project directory for a cwd, returning its absolute
 * path or null. Tries the encoded name, then falls back to a case-insensitive
 * scan of ~/.claude/projects/ so minor casing/encoding differences still match.
 */
export function findClaudeProjectDir(cwd: string): string | null {
  const base = path.join(homeDir(), ".claude", "projects");
  const encoded = claudeProjectDirName(cwd);
  const exact = path.join(base, encoded);
  if (existsSync(exact)) return exact;
  try {
    const match = readdirSync(base).find(
      (e) => e.toLowerCase() === encoded.toLowerCase()
    );
    return match ? path.join(base, match) : null;
  } catch {
    return null;
  }
}

/**
 * Check whether a TCP port is currently accepting connections (in use),
 * cross-platform, with no dependency on `lsof`/`netstat`.
 *
 * Attempts to bind the port: if binding fails with EADDRINUSE the port is busy.
 */
export function isPortInUse(
  port: number,
  host = "127.0.0.1"
): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", (err: NodeJS.ErrnoException) => {
        resolve(err.code === "EADDRINUSE" || err.code === "EACCES");
      })
      .once("listening", () => {
        tester.close(() => resolve(false));
      })
      .listen(port, host);
  });
}
