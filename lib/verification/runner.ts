/**
 * Shared, cross-platform verification command runner.
 *
 * Verification commands are parsed into argv steps and executed directly. The
 * literal `&&` is Stoa's step delimiter; no command is passed to a shell.
 */

import { execFile, spawn, type ChildProcess } from "child_process";
import { isWindows, killTreeArgs, resolveBinary } from "../platform";

export const VERIFY_TIMEOUT_DEFAULT_MS = 600_000;
// Fleet's durable verification/merge leases reserve one additional minute and
// are capped at 24 hours. Keep the accepted process timeout below that same
// boundary so no supported configuration can outlive its exclusive Git lease.
export const VERIFY_TIMEOUT_MAX_MS = 24 * 60 * 60 * 1000 - 60_000;

export function parseVerifyTimeoutMs(raw: string | undefined): number {
  if (raw == null) return VERIFY_TIMEOUT_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0
    ? Math.min(Math.floor(n), VERIFY_TIMEOUT_MAX_MS)
    : VERIFY_TIMEOUT_DEFAULT_MS;
}

/** Hard ceiling for one verification run before it is killed. */
export const VERIFY_TIMEOUT_MS = parseVerifyTimeoutMs(
  process.env.STOA_VERIFY_TIMEOUT_MS
);

/** Maximum child-process output retained by Node before it aborts the step. */
export const VERIFY_MAX_OUTPUT_BUFFER = 64 * 1024 * 1024;

/** Maximum failing output persisted in a verification result. */
export const VERIFY_OUTPUT_TAIL_MAX = 8000;

const VERIFICATION_ENV_ALLOWLIST = new Set(
  [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "USER",
    "USERNAME",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "TERM",
    "COLORTERM",
    "TZ",
    "NODE_ENV",
    "JAVA_HOME",
    "JDK_HOME",
    "GOROOT",
    "GOPATH",
    "GOBIN",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "DOTNET_ROOT",
    "DOTNET_CLI_HOME",
    "VIRTUAL_ENV",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ].map((name) => name.toUpperCase())
);

/**
 * Verification commands are repository-controlled code. Give them only the
 * OS/toolchain environment needed to execute; never inherit Stoa authority,
 * provider credentials, package-registry tokens, or cloud credentials.
 */
export function buildVerificationEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    NODE_ENV:
      source.NODE_ENV === "development" || source.NODE_ENV === "production"
        ? source.NODE_ENV
        : "test",
  };
  for (const [name, value] of Object.entries(source)) {
    const normalized = name.toUpperCase();
    if (
      normalized !== "CI" &&
      value !== undefined &&
      VERIFICATION_ENV_ALLOWLIST.has(normalized)
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

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

export interface RunVerifyOptions {
  /** Test/embedding override; production callers use VERIFY_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Test/embedding override; production callers use VERIFY_MAX_OUTPUT_BUFFER. */
  maxOutputBuffer?: number;
}

interface VerifyStepResult {
  code: number | string | null;
  killed: boolean;
  output: string;
  reason: string;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : fallback;
}

function processClosed(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

interface PosixProcess {
  pid: number;
  ppid: number;
  state: string;
}

const POSIX_TREE_SWEEP_LIMIT = 4;
const POSIX_SNAPSHOT_TIMEOUT_MS = 500;
const POSIX_SNAPSHOT_MAX_BUFFER = 4 * 1024 * 1024;

function parsePosixProcessSnapshot(stdout: string): PosixProcess[] {
  const processes: PosixProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    processes.push({ pid, ppid, state: match[3] });
  }
  return processes;
}

function collectPosixDescendants(
  processes: PosixProcess[],
  rootPid: number
): PosixProcess[] {
  const byParent = new Map<number, PosixProcess[]>();
  for (const processInfo of processes) {
    if (processInfo.pid === processInfo.ppid) continue;
    const children = byParent.get(processInfo.ppid);
    if (children) children.push(processInfo);
    else byParent.set(processInfo.ppid, [processInfo]);
  }

  const descendants: PosixProcess[] = [];
  const seen = new Set<number>([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    const parentPid = pending.shift()!;
    for (const child of byParent.get(parentPid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      descendants.push(child);
      pending.push(child.pid);
    }
  }
  return descendants;
}

function snapshotPosixProcesses(
  psBinary: string
): Promise<PosixProcess[] | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        psBinary,
        ["-A", "-o", "pid=,ppid=,stat="],
        {
          encoding: "utf8",
          killSignal: "SIGKILL",
          maxBuffer: POSIX_SNAPSHOT_MAX_BUFFER,
          timeout: POSIX_SNAPSHOT_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout) => {
          resolve(error ? null : parsePosixProcessSnapshot(stdout));
        }
      );
    } catch {
      resolve(null);
    }
  });
}

function safePosixTarget(pid: number): boolean {
  return (
    Number.isSafeInteger(pid) &&
    pid > 1 &&
    pid !== process.pid &&
    pid !== process.ppid
  );
}

function signalPosixProcess(pid: number, signal: NodeJS.Signals): boolean {
  if (!safePosixTarget(pid)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Freeze and collect descendants before destroying the root process group.
 * `detached: true`/setsid can leave that group while retaining a PPID link, so
 * each snapshot closes over PPIDs and freezes escaped descendants individually.
 * Repeating until stable closes the snapshot-to-SIGSTOP fork race while keeping
 * cleanup bounded.
 *
 * Portable unprivileged POSIX APIs cannot recover a daemon that double-forks
 * and reparents before the first snapshot. Hostile verification still needs an
 * external OS containment boundary (for example a cgroup/container); this sweep
 * covers ordinary Node detached children without assuming Linux-only facilities.
 */
async function collectAndFreezePosixTree(rootPid: number): Promise<number[]> {
  try {
    process.kill(-rootPid, "SIGSTOP");
  } catch {
    // The group may already be gone. A snapshot can still find a surviving
    // detached child while its PPID relationship remains observable.
  }

  const psBinary = resolveBinary("ps");
  if (!psBinary) return [];

  const frozen: number[] = [];
  const seen = new Set<number>();
  for (let round = 0; round < POSIX_TREE_SWEEP_LIMIT; round += 1) {
    const snapshot = await snapshotPosixProcesses(psBinary);
    if (!snapshot) break;
    const descendants = collectPosixDescendants(snapshot, rootPid);
    let newlyFrozen = 0;
    for (const descendant of descendants) {
      if (seen.has(descendant.pid) || descendant.state.startsWith("Z")) {
        continue;
      }
      if (!signalPosixProcess(descendant.pid, "SIGSTOP")) continue;
      seen.add(descendant.pid);
      frozen.push(descendant.pid);
      newlyFrozen += 1;
    }
    if (newlyFrozen === 0) break;
  }
  return frozen;
}

/**
 * Kill the exact verification process tree. Windows needs `taskkill /T /F`
 * because the direct child can be cmd.exe wrapping an npm `.cmd` shim. POSIX
 * verification children start in their own process group. A bounded PPID sweep
 * also captures descendants that escape that group with setsid()/detached.
 */
async function killVerifyTree(
  child: ChildProcess,
  onWindows: boolean
): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    child.kill("SIGKILL");
    return;
  }

  const argv = killTreeArgs(pid, onWindows);
  if (!argv) {
    const descendants = await collectAndFreezePosixTree(pid);
    let groupKilled = false;
    try {
      process.kill(-pid, "SIGKILL");
      groupKilled = true;
    } catch {
      // The group may have exited between the snapshot and this call.
    }
    // Reverse discovery order is leaf-first for the breadth-first PPID walk.
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      signalPosixProcess(descendants[index], "SIGKILL");
    }
    // Preserve the direct-child fallback for test doubles and unusual hosts
    // where negative-PID process-group signaling is unavailable.
    if (!groupKilled && !processClosed(child)) child.kill("SIGKILL");
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (fallback: boolean) => {
      if (settled) return;
      settled = true;
      if (fallback && !processClosed(child)) child.kill("SIGKILL");
      resolve();
    };
    try {
      const killer = spawn(argv[0], argv.slice(1), {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      killer.once("error", () => finish(true));
      killer.once("close", (code) => finish(code !== 0));
    } catch {
      finish(true);
    }
  });
}

function appendOutputTail(
  current: string,
  chunk: Buffer
): { value: string; truncated: boolean } {
  const combined = current + chunk.toString("utf-8");
  return combined.length > VERIFY_OUTPUT_TAIL_MAX
    ? {
        value: combined.slice(-VERIFY_OUTPUT_TAIL_MAX),
        truncated: true,
      }
    : { value: combined, truncated: false };
}

function displayOutputTail(value: string, truncated: boolean): string {
  return truncated ? `…(truncated)…\n${value}` : value;
}

/**
 * Execute one already-tokenized step and retain ownership of its process tree.
 * The returned promise waits for both the direct child and the platform tree
 * killer before resolving on a timeout/output limit.
 */
async function runVerifyStep(
  file: string,
  args: string[],
  cwd: string,
  options: Required<RunVerifyOptions>,
  onWindows: boolean
): Promise<VerifyStepResult> {
  return new Promise<VerifyStepResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd,
        env: buildVerificationEnvironment(),
        detached: !onWindows,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "SPAWN_ERROR";
      resolve({
        code,
        killed: false,
        output: "",
        reason: `spawn error: ${code}`,
      });
      return;
    }

    let output = "";
    let outputTruncated = false;
    let outputBytes = 0;
    let spawnCode: string | null = null;
    let terminationReason: "timeout" | "maxBuffer" | null = null;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: VerifyStepResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const limitedResult = (
      reason: "timeout" | "maxBuffer"
    ): VerifyStepResult => {
      const body = displayOutputTail(output, outputTruncated);
      return reason === "timeout"
        ? {
            code: null,
            killed: true,
            output: body,
            reason: `timed out after ${Math.round(options.timeoutMs / 1000)}s`,
          }
        : {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            killed: false,
            output: body,
            reason: `output exceeded ${options.maxOutputBuffer / (1024 * 1024)} MB`,
          };
    };

    const releaseOwnedHandles = () => {
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        try {
          stream.destroy();
        } catch {
          // The pipe may already have closed while tree teardown was running.
        }
        try {
          (stream as typeof stream & { unref?: () => void }).unref?.();
        } catch {
          // `destroy` is the portable release; unref is an optional extra on
          // stream implementations backed by a ref-counted OS handle.
        }
      }
      try {
        child.unref();
      } catch {
        // A spawned child normally supports unref; tolerate narrow test doubles
        // and a handle that closed concurrently.
      }
    };

    const terminate = (reason: "timeout" | "maxBuffer") => {
      if (terminationReason) return;
      terminationReason = reason;
      void (async () => {
        try {
          await killVerifyTree(child, onWindows);
        } catch {
          // Tree cleanup is best-effort on a process that may already be gone;
          // the limit verdict must still settle and release owned handles.
        } finally {
          // A reparented descendant can retain copies of these pipe FDs after
          // the owned process tree is gone, so ChildProcess `close` may never
          // arrive. Limit handling owns finalization and never waits for EOF.
          releaseOwnedHandles();
          finish(limitedResult(reason));
        }
      })();
    };
    const collect = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      const next = appendOutputTail(output, buffer);
      output = next.value;
      outputTruncated ||= next.truncated;
      if (outputBytes > options.maxOutputBuffer) terminate("maxBuffer");
    };

    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => {
      spawnCode = (error as NodeJS.ErrnoException).code ?? "SPAWN_ERROR";
    });

    timer = setTimeout(() => terminate("timeout"), options.timeoutMs);
    timer.unref?.();

    child.once("close", (code, signal) => {
      // Once a limit fires, its finalizer owns the verdict even if `close`
      // races with tree teardown or arrives after forced stream destruction.
      if (terminationReason) return;
      const body = displayOutputTail(output, outputTruncated);
      if (spawnCode) {
        finish({
          code: spawnCode,
          killed: false,
          output: body,
          reason: `spawn error: ${spawnCode}`,
        });
        return;
      }
      const resultCode = code ?? signal ?? null;
      finish({
        code: resultCode,
        killed: false,
        output: body,
        reason:
          typeof resultCode === "string"
            ? `spawn error: ${resultCode}`
            : `exit ${resultCode}`,
      });
    });
  });
}

/** Run a verification command step by step without invoking a shell. */
export async function runVerify(
  cwd: string,
  command: string,
  options: RunVerifyOptions = {}
): Promise<VerifyResult> {
  const parsed = parseVerifySteps(command);
  if (!("steps" in parsed)) return { status: "error", output: parsed.error };

  const limits: Required<RunVerifyOptions> = {
    timeoutMs: positiveLimit(options.timeoutMs, VERIFY_TIMEOUT_MS),
    maxOutputBuffer: positiveLimit(
      options.maxOutputBuffer,
      VERIFY_MAX_OUTPUT_BUFFER
    ),
  };

  for (const step of parsed.steps) {
    const resolved = resolveBinary(step[0]);
    if (!resolved) {
      return { status: "error", output: `verify binary not found: ${step[0]}` };
    }
    const { file, args } = spawnArgs(resolved, step.slice(1), isWindows);
    const result = await runVerifyStep(file, args, cwd, limits, isWindows);
    if (result.code === 0 && !result.killed) continue;
    const status = summarizeVerifyExit({
      ok: false,
      code: result.code,
      killed: result.killed,
    });
    return {
      status,
      output:
        `$ ${step.join(" ")}\n[${result.reason}]\n${result.output}`.trim(),
    };
  }

  return { status: "pass", output: "" };
}
