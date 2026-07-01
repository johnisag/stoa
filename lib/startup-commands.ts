/**
 * Per-project startup commands (#14b) — the safe RUNNER.
 *
 * A project can configure commands (build, codegen, db migrate) that run when a
 * new session's worktree is set up, warming it beyond `npm install`. Unlike the
 * repo-file `.stoa/worktrees.json` `setup[]` (shell strings, run as-authored),
 * these are UI-authored and DB-backed, so they follow the AGENTS.md hard rule:
 * NO shell-string exec — the command is tokenized into argv
 * (`tokenizeCommand` rejects shell metacharacters), the binary resolved on PATH,
 * and executed with `execFile` (shell:false). Env vars (WORKTREE_PATH, PORT, …)
 * are passed via the spawn `env` option, never string-interpolated.
 *
 * Kept DB-FREE on purpose: callers fetch the command rows and pass plain specs,
 * so this module never drags `lib/db` (which opens the database at import) into
 * env-setup or tests. Exec + binary resolution are injectable for OS-agnostic
 * unit tests (the same seam style as lib/transcript-cache.ts).
 */

import { execFile } from "child_process";
import { tokenizeCommand } from "./api-security";
import { resolveBinary, isWindows } from "./platform";

export interface StartupCommandSpec {
  name: string;
  command: string;
}

/** Mirrors the step shape of env-setup's SetupResult so results merge in. */
export interface StartupStepResult {
  name: string;
  command: string;
  success: boolean;
  output?: string;
  error?: string;
}

/** Per-command timeout — matches env-setup's existing setup-step timeout. */
const STARTUP_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Route a resolved binary through `cmd.exe /c` when it's a Windows `.cmd`/`.bat`
 * shim (npm/npx/yarn), keeping shell:false — Node ≥18.20 refuses to spawn those
 * directly (CVE-2024-27980), and cmd.exe /c with an argv array quotes each token
 * (no injection surface). Mirrors `resolveDevServerSpawn` in lib/dev-servers.ts;
 * kept separate so this module stays DB-free (dev-servers imports the live DB at
 * module load). Both are locked by tests, so they can't silently drift apart.
 */
export function resolveStartupSpawn(
  binaryPath: string,
  args: string[],
  onWindows: boolean
): { file: string; args: string[] } {
  if (onWindows && /\.(cmd|bat)$/i.test(binaryPath)) {
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/c", binaryPath, ...args],
    };
  }
  return { file: binaryPath, args };
}

export type ExecFileFn = (
  file: string,
  args: string[],
  opts: {
    cwd: string;
    timeout: number;
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
  }
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    // windowsHide forced HERE (not only by the caller) so the default runner can
    // never flash a console window — and the repo-wide windows-hide coverage
    // guard can see it literally at the call site.
    execFile(
      file,
      args,
      { ...opts, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          // Attach captured output so the step result can still show it.
          (
            err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
          ).stdout = stdout;
          (
            err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
          ).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
  });

/**
 * Run the commands in order inside `cwd`, each safe-exec'd (tokenize → resolve →
 * argv execFile, `.cmd` shims routed via cmd.exe /c). A failing command is
 * recorded and the REST still run (a warmup step is non-fatal — the agent can
 * always redo it); nothing here ever throws. `extraEnv` (WORKTREE_PATH, PORT, …)
 * is merged over process.env for the child only.
 */
export async function runStartupCommands(
  commands: StartupCommandSpec[],
  cwd: string,
  extraEnv: Record<string, string> = {},
  deps?: {
    execFileFn?: ExecFileFn;
    resolveBin?: (name: string) => string | null;
    onWindows?: boolean;
  }
): Promise<StartupStepResult[]> {
  const exec = deps?.execFileFn ?? defaultExecFile;
  const resolveBin = deps?.resolveBin ?? resolveBinary;
  const onWindows = deps?.onWindows ?? isWindows;
  const results: StartupStepResult[] = [];

  for (const spec of commands) {
    try {
      const argv = tokenizeCommand(spec.command);
      const binaryPath = resolveBin(argv[0]);
      if (!binaryPath) {
        throw new Error(`Command not found on PATH: ${argv[0]}`);
      }
      const { file, args } = resolveStartupSpawn(
        binaryPath,
        argv.slice(1),
        onWindows
      );
      const { stdout, stderr } = await exec(file, args, {
        cwd,
        timeout: STARTUP_COMMAND_TIMEOUT_MS,
        env: { ...process.env, ...extraEnv },
        windowsHide: true,
      });
      results.push({
        name: spec.name,
        command: spec.command,
        success: true,
        output: stdout + (stderr ? `\n${stderr}` : ""),
      });
    } catch (error: unknown) {
      const err = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      results.push({
        name: spec.name,
        command: spec.command,
        success: false,
        output: err.stdout || "",
        error: err.stderr || err.message || "Unknown error",
      });
    }
  }

  return results;
}
