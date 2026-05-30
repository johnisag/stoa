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
    const first = out.split(/\r?\n/).find((l) => l.trim().length > 0);
    return first ? first.trim() : null;
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
