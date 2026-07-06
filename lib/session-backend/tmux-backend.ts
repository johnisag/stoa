/**
 * Tmux implementation of SessionBackend.
 *
 * Reproduces, byte-for-byte where it matters, the tmux command strings that
 * used to be assembled inline across lib/ and app/api/. This is the macOS/Linux
 * backend and the behavioral reference for the future pty backend.
 *
 * POSIX-only by design: create uses argv-safe `execFile`; read/control helpers
 * retain the historical tmux shell snippets (`||`, `2>/dev/null`). The pty backend
 * does not use a shell at all.
 */

import { exec, execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import path from "path";
import { expandHome, resolveBinary, tmpDir } from "../platform";
import type {
  SessionBackend,
  SessionActivity,
  CaptureOptions,
  CreateOptions,
  SendOptions,
} from "./types";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const tmuxBinary = resolveBinary("tmux") || "tmux";

/**
 * Wrap a session name for use inside a double-quoted shell argument, escaping the
 * characters that stay active inside double quotes (`\ " $ \``). Names reaching the
 * backend today are internally generated (`sessionKey()` = `${provider}-${uuid}`)
 * so this is contract hardening (AGENTS.md: "the backend owns escaping"), not a
 * reachable injection — and it's a no-op for those metacharacter-free names, so the
 * locked command strings are unchanged.
 */
function q(name: string): string {
  return `"${name.replace(/(["\\$`])/g, "\\$1")}"`;
}

let pasteCounter = 0;

export class TmuxBackend implements SessionBackend {
  async create({ name, cwd, command }: CreateOptions): Promise<void> {
    const resolvedCwd = expandHome(cwd);
    await execFileAsync(tmuxBinary, ["set", "-g", "mouse", "on"], {
      windowsHide: true,
    });
    await execFileAsync(
      tmuxBinary,
      ["new-session", "-d", "-s", name, "-c", resolvedCwd, command],
      { windowsHide: true }
    );
  }

  async kill(name: string): Promise<void> {
    await execAsync(`tmux kill-session -t ${q(name)} 2>/dev/null || true`, {
      timeout: 5000,
    });
  }

  async rename(oldName: string, newName: string): Promise<void> {
    await execAsync(`tmux rename-session -t ${q(oldName)} ${q(newName)}`);
  }

  async exists(name: string): Promise<boolean> {
    try {
      await execAsync(`tmux has-session -t ${q(name)} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<string[]> {
    try {
      const { stdout } = await execAsync(
        "tmux list-sessions -F '#{session_name}' 2>/dev/null || true"
      );
      return stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  async listWithActivity(): Promise<SessionActivity[]> {
    try {
      const { stdout } = await execAsync(
        `tmux list-sessions -F '#{session_name}\t#{session_activity}' 2>/dev/null || echo ""`
      );
      const out: SessionActivity[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [name, activity] = trimmed.split("\t");
        if (!name) continue;
        const parsed = activity ? parseInt(activity, 10) : NaN;
        out.push({ name, activity: Number.isNaN(parsed) ? null : parsed });
      }
      return out;
    } catch {
      return [];
    }
  }

  async getPanePath(name: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(
        `tmux display-message -t ${q(name)} -p "#{pane_current_path}" 2>/dev/null || echo ""`
      );
      const value = stdout.trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  async getEnv(name: string, varName: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(
        `tmux show-environment -t ${q(name)} ${varName} 2>/dev/null || echo ""`
      );
      // Output form is "VAR=value"; "-VAR" means unset.
      const line = stdout.trim();
      const prefix = `${varName}=`;
      if (line.startsWith(prefix)) {
        return line.slice(prefix.length);
      }
      return null;
    } catch {
      return null;
    }
  }

  async getPid(name: string): Promise<number | null> {
    try {
      const { stdout } = await execAsync(
        `tmux display-message -t ${q(name)} -p "#{pane_pid}" 2>/dev/null || echo ""`
      );
      const pid = parseInt(stdout.trim(), 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  async capture(name: string, opts?: CaptureOptions): Promise<string> {
    const range = opts?.lines != null ? ` -S -${opts.lines}` : "";
    try {
      const { stdout } = await execAsync(
        `tmux capture-pane -t ${q(name)} -p${range} 2>/dev/null`
      );
      return stdout;
    } catch {
      return "";
    }
  }

  async sendEnter(name: string): Promise<void> {
    await execAsync(`tmux send-keys -t ${q(name)} Enter`);
  }

  async sendEscape(name: string): Promise<void> {
    await execAsync(`tmux send-keys -t ${q(name)} Escape`);
  }

  async sendKeysLiteral(name: string, text: string): Promise<void> {
    // Single-quote escaping for the shell (matches the previous inline escaping).
    const escaped = text.replace(/'/g, "'\\''");
    await execAsync(`tmux send-keys -t ${q(name)} -l '${escaped}'`);
  }

  async sendKeysInterpreted(
    name: string,
    text: string,
    opts?: SendOptions
  ): Promise<void> {
    // Double-quote escaping for the shell (matches the previous inline escaping).
    const escaped = text.replace(/"/g, '\\"').replace(/\$/g, "\\$");
    const enter = opts?.enter ? " Enter" : "";
    await execAsync(`tmux send-keys -t ${q(name)} "${escaped}"${enter}`);
  }

  async pasteText(
    name: string,
    text: string,
    opts?: SendOptions
  ): Promise<void> {
    // Route arbitrary/multi-line text through a tmux buffer via a temp file to
    // avoid send-keys escaping/interpretation issues.
    const unique = `${process.pid}-${++pasteCounter}`;
    const tempFile = path.join(tmpDir(), `stoa-send-${unique}.txt`);
    const bufferName = `send-${unique}`;
    try {
      await writeFile(tempFile, text);
      await execAsync(`tmux load-buffer -b ${q(bufferName)} "${tempFile}"`);
      await execAsync(`tmux paste-buffer -b ${q(bufferName)} -t ${q(name)}`);
      await execAsync(`tmux delete-buffer -b ${q(bufferName)}`).catch(() => {});
      if (opts?.enter) {
        await execAsync(`tmux send-keys -t ${q(name)} Enter`);
      }
    } finally {
      await unlink(tempFile).catch(() => {});
    }
  }
}
