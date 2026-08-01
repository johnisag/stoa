/**
 * Shared, cross-platform verification command runner.
 *
 * Verification commands are parsed into argv steps and executed directly. The
 * literal `&&` is Stoa's step delimiter; no command is passed to a shell.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { isWindows, resolveBinary } from "../platform";

const execFileAsync = promisify(execFile);

/** Hard ceiling for one verification run before it is killed. */
export const VERIFY_TIMEOUT_MS = (() => {
  const raw = process.env.STOA_VERIFY_TIMEOUT_MS;
  if (raw == null) return 600_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600_000;
})();

/** Maximum child-process output retained by Node before it aborts the step. */
export const VERIFY_MAX_OUTPUT_BUFFER = 64 * 1024 * 1024;

/** Maximum failing output persisted in a verification result. */
export const VERIFY_OUTPUT_TAIL_MAX = 8000;

export type VerifyStatus = "running" | "pass" | "fail" | "error";

// `&&` is consumed as Stoa's delimiter before tokenization. The remaining shell
// metacharacters are rejected even inside double quotes. Quotes are removed when
// building argv, and cmd.exe can still interpret quoted metacharacters while
// routing Windows `.cmd` and `.bat` shims. `%` and `^` are included for the same
// reason.
const SHELL_METACHARS = "|&;<>`$(){}%^";

function tokenizeStep(step: string): string[] | { error: string } {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let building = false;

  for (const character of step) {
    if (SHELL_METACHARS.includes(character)) {
      return {
        error: `shell operators are not allowed (found "${character}"); chain steps with && and quote args`,
      };
    }
    if (character === '"') {
      inQuote = !inQuote;
      building = true;
      continue;
    }
    if (!inQuote) {
      if (character === "\n" || character === "\r") {
        return { error: "a newline is not allowed in a verify step" };
      }
      if (character === "'") {
        return {
          error:
            "single quotes are not supported; use double quotes for args with spaces",
        };
      }
      if (character === " " || character === "\t") {
        if (building) {
          tokens.push(current);
          current = "";
          building = false;
        }
        continue;
      }
    }
    current += character;
    building = true;
  }

  if (inQuote) return { error: "unterminated quote in the verify command" };
  if (building) tokens.push(current);
  return tokens;
}

/** Parse a verification command into direct-execution argv steps. */
export function parseVerifySteps(
  command: string
): { steps: string[][] } | { error: string } {
  if (!command || !command.trim()) {
    return { error: "the verify command is empty" };
  }
  const steps: string[][] = [];
  for (const raw of command.split("&&")) {
    const tokens = tokenizeStep(raw);
    if (!Array.isArray(tokens)) return tokens;
    if (tokens.length === 0) {
      return { error: "an empty step (check the && placement)" };
    }
    steps.push(tokens);
  }
  return { steps };
}

/** Map one process outcome to a verification verdict. */
export function summarizeVerifyExit(info: {
  ok: boolean;
  code: number | string | null;
  killed: boolean;
}): VerifyStatus {
  if (info.ok) return "pass";
  if (info.killed) return "error";
  if (typeof info.code === "string") return "error";
  return "fail";
}

/**
 * Resolve the executable call for a verification step. Windows command shims
 * must go through `cmd.exe /c`; all other binaries execute directly.
 */
export function spawnArgs(
  resolvedBin: string,
  args: string[],
  onWindows: boolean
): { file: string; args: string[] } {
  if (onWindows && /\.(cmd|bat)$/i.test(resolvedBin)) {
    const comspec = process.env.ComSpec || "cmd.exe";
    return { file: comspec, args: ["/c", resolvedBin, ...args] };
  }
  return { file: resolvedBin, args };
}

export interface VerifyResult {
  status: VerifyStatus;
  output: string;
}

function outputTail(value: string): string {
  return value.length > VERIFY_OUTPUT_TAIL_MAX
    ? `…(truncated)…\n${value.slice(-VERIFY_OUTPUT_TAIL_MAX)}`
    : value;
}

/** Run a verification command step by step without invoking a shell. */
export async function runVerify(
  cwd: string,
  command: string
): Promise<VerifyResult> {
  const parsed = parseVerifySteps(command);
  if (!("steps" in parsed)) return { status: "error", output: parsed.error };

  for (const step of parsed.steps) {
    const resolved = resolveBinary(step[0]);
    if (!resolved) {
      return { status: "error", output: `verify binary not found: ${step[0]}` };
    }
    const { file, args } = spawnArgs(resolved, step.slice(1), isWindows);
    try {
      await execFileAsync(file, args, {
        cwd,
        encoding: "utf-8",
        timeout: VERIFY_TIMEOUT_MS,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: VERIFY_MAX_OUTPUT_BUFFER,
        env: { ...process.env, CI: "1" },
      });
    } catch (error) {
      const processError = error as {
        code?: number | string | null;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };
      const status = summarizeVerifyExit({
        ok: false,
        code: processError.code ?? null,
        killed: !!processError.killed,
      });
      const reason = processError.killed
        ? `timed out after ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s`
        : processError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? `output exceeded ${VERIFY_MAX_OUTPUT_BUFFER / (1024 * 1024)} MB`
          : typeof processError.code === "string"
            ? `spawn error: ${processError.code}`
            : `exit ${processError.code}`;
      const body = (processError.stdout ?? "") + (processError.stderr ?? "");
      return {
        status,
        output: `$ ${step.join(" ")}\n[${reason}]\n${outputTail(body)}`.trim(),
      };
    }
  }

  return { status: "pass", output: "" };
}
