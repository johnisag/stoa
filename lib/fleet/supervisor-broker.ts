import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { isWindows, killTreeArgs } from "../platform";
import {
  MANAGED_FLEET_SUPERVISOR_PROMPT_MAX_CHARS,
  MANAGED_FLEET_SUPERVISOR_RESULT_MAX_BYTES,
} from "./supervisor-contract";

export const MANAGED_SUPERVISOR_BROKER_VERSION = 2 as const;
export const MANAGED_SUPERVISOR_SESSION_ROLE = "fleet_supervisor" as const;
export const MANAGED_SUPERVISOR_GROUP_PATH = "__fleet_internal__" as const;
export const MANAGED_SUPERVISOR_READY =
  "STOA_FLEET_SUPERVISOR_V2_READY" as const;
export const MANAGED_SUPERVISOR_STARTED =
  "STOA_FLEET_SUPERVISOR_V2_STARTED" as const;

const PROMPT_PREFIX = "STOA_FLEET_SUPERVISOR_PROMPT_V1 ";
const RESULT_BEGIN = "STOA_FLEET_SUPERVISOR_V1_BEGIN";
const RESULT_END = "STOA_FLEET_SUPERVISOR_V1_END";
const RESULT_CAPTURE_MAX_CHARS = 96 * 1024;
const STDERR_MAX_BYTES = 4 * 1024;
const FRAME_CHUNK_CHARS = 64;

export const MANAGED_SUPERVISOR_ENV_KEYS = [
  "NODE_ENV",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ANTHROPIC_API_KEY",
] as const;

export interface ManagedSupervisorClaudeSpawn {
  schemaVersion: typeof MANAGED_SUPERVISOR_BROKER_VERSION;
  binary: string;
  argsPrefix: string[];
  model: string | null;
}

export interface ManagedSupervisorBrokerProfile {
  version: typeof MANAGED_SUPERVISOR_BROKER_VERSION;
  role: typeof MANAGED_SUPERVISOR_SESSION_ROLE;
  provider: "claude";
  approvalMode: "prompt";
  tools: "none";
  mcp: "none";
  sessionPersistence: false;
  brokerProtocol: "framed-pty-v2-ready";
  providerBinary: string;
  providerArgs: string[];
  environmentKeys: string[];
  backendKey: string;
  workingDirectory: string;
  groupPath: typeof MANAGED_SUPERVISOR_GROUP_PATH;
  projectId: null;
}

export interface ManagedSupervisorProfileBinding {
  backendKey: string;
  workingDirectory: string;
  groupPath: typeof MANAGED_SUPERVISOR_GROUP_PATH;
  projectId: null;
}

export type ManagedSupervisorCapturedOutput =
  | { state: "pending" }
  | { state: "invalid"; error: string }
  | { state: "complete"; text: string; bytes: number };

export type ManagedSupervisorEnvironment = Record<string, string> & {
  NODE_ENV: "development" | "test" | "production";
};

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function parseSpawn(value: unknown): ManagedSupervisorClaudeSpawn {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, [
      "schemaVersion",
      "binary",
      "argsPrefix",
      "model",
    ])
  ) {
    throw new Error("invalid managed supervisor broker launch profile");
  }
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== MANAGED_SUPERVISOR_BROKER_VERSION ||
    typeof input.binary !== "string" ||
    !isAbsolute(input.binary) ||
    input.binary.length > 4096 ||
    input.binary.includes("\0") ||
    !Array.isArray(input.argsPrefix) ||
    input.argsPrefix.length > 4 ||
    input.argsPrefix.some(
      (token) =>
        typeof token !== "string" || token.length > 4096 || token.includes("\0")
    ) ||
    (input.model !== null &&
      (typeof input.model !== "string" ||
        input.model.length === 0 ||
        input.model.length > 256 ||
        input.model.includes("\0")))
  ) {
    throw new Error("invalid managed supervisor broker launch profile");
  }
  return input as unknown as ManagedSupervisorClaudeSpawn;
}

/** Exact verified Claude print-mode profile. No caller can add a tool, MCP,
 * permission bypass, settings, hook, plugin, slash command, or persistence flag. */
export function managedSupervisorClaudeArgs(model: string | null): string[] {
  return [
    "-p",
    "--bare",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    "{}",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    ...(model ? ["--model", model] : []),
  ];
}

/** A true allowlist: arbitrary parent credentials never reach broker or Claude. */
export function managedSupervisorEnvironment(
  inherited: Readonly<Record<string, string | undefined>> = process.env
): ManagedSupervisorEnvironment {
  const environment: ManagedSupervisorEnvironment = {
    NODE_ENV:
      inherited.NODE_ENV === "development" ||
      inherited.NODE_ENV === "test" ||
      inherited.NODE_ENV === "production"
        ? inherited.NODE_ENV
        : "production",
  };
  for (const key of MANAGED_SUPERVISOR_ENV_KEYS) {
    if (key === "NODE_ENV") continue;
    const value = inherited[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export function hasManagedSupervisorEnvironmentAuth(
  environment: Readonly<Record<string, string | undefined>>
): boolean {
  const value = environment.ANTHROPIC_API_KEY;
  return typeof value === "string" && value.trim().length > 0;
}

export function managedSupervisorBrokerProfile(
  spawn: ManagedSupervisorClaudeSpawn,
  binding: ManagedSupervisorProfileBinding
): ManagedSupervisorBrokerProfile {
  const parsed = parseSpawn(spawn);
  if (
    !binding ||
    typeof binding.backendKey !== "string" ||
    binding.backendKey.length === 0 ||
    binding.backendKey.length > 256 ||
    binding.backendKey.includes("\0") ||
    typeof binding.workingDirectory !== "string" ||
    !isAbsolute(binding.workingDirectory) ||
    binding.workingDirectory.length > 4096 ||
    binding.workingDirectory.includes("\0") ||
    binding.groupPath !== MANAGED_SUPERVISOR_GROUP_PATH ||
    binding.projectId !== null
  ) {
    throw new Error("invalid managed supervisor session binding");
  }
  return {
    version: MANAGED_SUPERVISOR_BROKER_VERSION,
    role: MANAGED_SUPERVISOR_SESSION_ROLE,
    provider: "claude",
    approvalMode: "prompt",
    tools: "none",
    mcp: "none",
    sessionPersistence: false,
    brokerProtocol: "framed-pty-v2-ready",
    providerBinary: parsed.binary,
    providerArgs: [
      ...parsed.argsPrefix,
      ...managedSupervisorClaudeArgs(parsed.model),
    ],
    environmentKeys: [...MANAGED_SUPERVISOR_ENV_KEYS],
    ...binding,
  };
}

export function managedSupervisorProfileJson(
  profile: ManagedSupervisorBrokerProfile
): string {
  return JSON.stringify(profile);
}

export function managedSupervisorProfileHash(profileJson: string): string {
  return createHash("sha256").update(profileJson, "utf8").digest("hex");
}

export function parseManagedSupervisorProfileJson(
  profileJson: string
): ManagedSupervisorBrokerProfile {
  let value: unknown;
  try {
    value = JSON.parse(profileJson);
  } catch {
    throw new Error("invalid managed supervisor profile JSON");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, [
      "version",
      "role",
      "provider",
      "approvalMode",
      "tools",
      "mcp",
      "sessionPersistence",
      "brokerProtocol",
      "providerBinary",
      "providerArgs",
      "environmentKeys",
      "backendKey",
      "workingDirectory",
      "groupPath",
      "projectId",
    ])
  ) {
    throw new Error("invalid managed supervisor profile");
  }
  const profile = value as Record<string, unknown>;
  const environmentKeys = profile.environmentKeys;
  if (
    profile.version !== MANAGED_SUPERVISOR_BROKER_VERSION ||
    profile.role !== MANAGED_SUPERVISOR_SESSION_ROLE ||
    profile.provider !== "claude" ||
    profile.approvalMode !== "prompt" ||
    profile.tools !== "none" ||
    profile.mcp !== "none" ||
    profile.sessionPersistence !== false ||
    profile.brokerProtocol !== "framed-pty-v2-ready" ||
    typeof profile.providerBinary !== "string" ||
    !isAbsolute(profile.providerBinary) ||
    !Array.isArray(profile.providerArgs) ||
    profile.providerArgs.some(
      (token) => typeof token !== "string" || token.includes("\0")
    ) ||
    !Array.isArray(environmentKeys) ||
    environmentKeys.length !== MANAGED_SUPERVISOR_ENV_KEYS.length ||
    environmentKeys.some(
      (key, index) => key !== MANAGED_SUPERVISOR_ENV_KEYS[index]
    )
  ) {
    throw new Error("invalid managed supervisor profile");
  }
  managedSupervisorBrokerProfile(
    {
      schemaVersion: MANAGED_SUPERVISOR_BROKER_VERSION,
      binary: profile.providerBinary,
      argsPrefix: [],
      model: null,
    },
    {
      backendKey: profile.backendKey as string,
      workingDirectory: profile.workingDirectory as string,
      groupPath: profile.groupPath as typeof MANAGED_SUPERVISOR_GROUP_PATH,
      projectId: profile.projectId as null,
    }
  );
  return value as ManagedSupervisorBrokerProfile;
}

export function managedSupervisorBrokerHasMarker(
  screen: string,
  marker: typeof MANAGED_SUPERVISOR_READY | typeof MANAGED_SUPERVISOR_STARTED
): boolean {
  return screen
    .replace(/\r/g, "")
    .split("\n")
    .some((line) => line.trim() === marker);
}

export function encodeManagedSupervisorBrokerConfig(
  spawn: ManagedSupervisorClaudeSpawn
): string {
  const parsed = parseSpawn(spawn);
  return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
}

export function managedSupervisorPromptFrame(prompt: string): string {
  if (prompt.length > MANAGED_FLEET_SUPERVISOR_PROMPT_MAX_CHARS) {
    throw new Error("managed supervisor prompt exceeds the safety limit");
  }
  return `${PROMPT_PREFIX}${Buffer.from(prompt, "utf8").toString("base64url")}`;
}

function strictBase64Url(value: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid managed supervisor broker frame encoding");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("invalid managed supervisor broker frame encoding");
  }
  return decoded;
}

function frameOutput(
  status: "OK" | "ERROR",
  exitCode: number,
  payload: Buffer
): string {
  const hash = createHash("sha256").update(payload).digest("hex");
  const encoded = payload.toString("base64");
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += FRAME_CHUNK_CHARS) {
    chunks.push(encoded.slice(offset, offset + FRAME_CHUNK_CHARS));
  }
  return [
    RESULT_BEGIN,
    status,
    String(exitCode),
    String(payload.byteLength),
    hash,
    ...chunks,
    RESULT_END,
    "",
  ].join("\r\n");
}

/** Test-only producer for parser/terminal-wrapping regression coverage. */
export function _managedSupervisorResultFrameForTests(
  text: string,
  options: { status?: "OK" | "ERROR"; exitCode?: number } = {}
): string {
  return frameOutput(
    options.status ?? "OK",
    options.exitCode ?? 0,
    Buffer.from(text, "utf8")
  );
}

/** Parse only a complete integrity-framed broker result from rendered terminal
 * capture. Partial output is pending; malformed completed output fails closed. */
export function parseManagedSupervisorCapturedOutput(
  screen: string
): ManagedSupervisorCapturedOutput {
  if (screen.length > RESULT_CAPTURE_MAX_CHARS) {
    return {
      state: "invalid",
      error: "managed supervisor capture is too large",
    };
  }
  const lines = screen
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim());
  const begin = lines.lastIndexOf(RESULT_BEGIN);
  if (begin < 0) return { state: "pending" };
  const end = lines.indexOf(RESULT_END, begin + 5);
  if (end < 0) return { state: "pending" };
  const status = lines[begin + 1];
  const exitCode = Number(lines[begin + 2]);
  const bytes = Number(lines[begin + 3]);
  const expectedHash = lines[begin + 4];
  if (
    (status !== "OK" && status !== "ERROR") ||
    !Number.isSafeInteger(exitCode) ||
    exitCode < 0 ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > MANAGED_FLEET_SUPERVISOR_RESULT_MAX_BYTES ||
    !/^[0-9a-f]{64}$/.test(expectedHash) ||
    lines
      .slice(begin + 5, end)
      .some((line) => !/^[A-Za-z0-9+/=]{1,64}$/.test(line))
  ) {
    return {
      state: "invalid",
      error: "managed supervisor broker frame is invalid",
    };
  }
  const payload = Buffer.from(lines.slice(begin + 5, end).join(""), "base64");
  const actualHash = createHash("sha256").update(payload).digest("hex");
  if (payload.byteLength !== bytes || actualHash !== expectedHash) {
    return {
      state: "invalid",
      error: "managed supervisor broker frame integrity check failed",
    };
  }
  const text = payload.toString("utf8");
  if (Buffer.byteLength(text, "utf8") !== payload.byteLength) {
    return {
      state: "invalid",
      error: "managed supervisor output is not UTF-8",
    };
  }
  if (status === "ERROR" || exitCode !== 0) {
    return {
      state: "invalid",
      error: `managed supervisor provider exited with code ${exitCode}`,
    };
  }
  return { state: "complete", text, bytes };
}

function boundedAppend(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  limit: number
): number {
  const next = currentBytes + chunk.byteLength;
  if (next > limit) {
    throw new Error(
      "managed supervisor provider output exceeded the safety limit"
    );
  }
  chunks.push(chunk);
  return next;
}

function stayAlive(): never {
  setInterval(() => undefined, 60 * 60 * 1000);
  return undefined as never;
}

function processClosed(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminateProviderTree(
  child: ChildProcessWithoutNullStreams
): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    if (!processClosed(child)) child.kill("SIGKILL");
    return;
  }
  const argv = killTreeArgs(pid, isWindows);
  if (!argv) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      if (!processClosed(child)) child.kill("SIGKILL");
    }
    return;
  }
  await new Promise<void>((resolveKill) => {
    let settled = false;
    const finish = (fallback: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fallback && !processClosed(child)) child.kill("SIGKILL");
      resolveKill();
    };
    const timer = setTimeout(() => finish(true), 2_000);
    timer.unref?.();
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

async function runBroker(encodedConfig: string): Promise<never> {
  let child: ChildProcessWithoutNullStreams | null = null;
  let termination: Promise<void> | null = null;
  let terminating = false;
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    termination = child ? terminateProviderTree(child) : Promise.resolve();
    void termination.finally(() => process.exit(0));
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  if (!isWindows) process.once("SIGHUP", terminate);

  let config: ManagedSupervisorClaudeSpawn;
  try {
    const decoded = strictBase64Url(encodedConfig);
    if (decoded.byteLength > 16 * 1024) {
      throw new Error("broker config is too large");
    }
    config = parseSpawn(JSON.parse(decoded.toString("utf8")));
  } catch (error) {
    const message = Buffer.from(
      error instanceof Error ? error.message : "invalid broker config",
      "utf8"
    );
    process.stdout.write(frameOutput("ERROR", 1, message));
    return stayAlive();
  }

  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
  }
  process.stdin.setEncoding("utf8");
  let input = "";
  const maxFrameChars =
    PROMPT_PREFIX.length +
    Math.ceil((MANAGED_FLEET_SUPERVISOR_PROMPT_MAX_CHARS * 4) / 3) +
    16;
  const promptPromise = new Promise<string>((resolvePrompt, rejectPrompt) => {
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
    };
    const onEnd = () => {
      cleanup();
      rejectPrompt(new Error("managed supervisor prompt stream ended early"));
    };
    const onData = (chunk: string) => {
      input += chunk;
      if (input.length > maxFrameChars) {
        cleanup();
        rejectPrompt(new Error("managed supervisor prompt frame is too large"));
        return;
      }
      const delimiter = input.search(/[\r\n]/);
      if (delimiter < 0) return;
      const line = input.slice(0, delimiter);
      cleanup();
      try {
        if (!line.startsWith(PROMPT_PREFIX)) {
          throw new Error("invalid managed supervisor prompt frame");
        }
        const decoded = strictBase64Url(line.slice(PROMPT_PREFIX.length));
        const value = decoded.toString("utf8");
        if (
          Buffer.byteLength(value, "utf8") !== decoded.byteLength ||
          value.length > MANAGED_FLEET_SUPERVISOR_PROMPT_MAX_CHARS
        ) {
          throw new Error("invalid managed supervisor prompt frame");
        }
        resolvePrompt(value);
      } catch (error) {
        rejectPrompt(error);
      }
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
  process.stdout.write(`${MANAGED_SUPERVISOR_READY}\r\n`);
  const prompt = await promptPromise.catch((error) => {
    const message = Buffer.from(
      error instanceof Error ? error.message : "invalid prompt frame",
      "utf8"
    );
    process.stdout.write(frameOutput("ERROR", 1, message));
    return null;
  });
  if (prompt === null) return stayAlive();
  process.stdout.write(`${MANAGED_SUPERVISOR_STARTED}\r\n`);

  child = spawn(
    config.binary,
    [...config.argsPrefix, ...managedSupervisorClaudeArgs(config.model)],
    {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      windowsHide: true,
      detached: !isWindows,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  child.stdin.end(prompt, "utf8");

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputError: Error | null = null;
  child.stdout.on("data", (chunk: Buffer) => {
    if (outputError) return;
    try {
      stdoutBytes = boundedAppend(
        stdout,
        chunk,
        stdoutBytes,
        MANAGED_FLEET_SUPERVISOR_RESULT_MAX_BYTES
      );
    } catch (error) {
      outputError = error as Error;
      termination ??= child ? terminateProviderTree(child) : Promise.resolve();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= STDERR_MAX_BYTES) return;
    const bounded = chunk.subarray(0, STDERR_MAX_BYTES - stderrBytes);
    stderr.push(bounded);
    stderrBytes += bounded.byteLength;
  });
  const exitCode = await new Promise<number>((resolveExit) => {
    child!.once("error", (error) => {
      outputError = error;
      resolveExit(1);
    });
    child!.once("close", (code) => resolveExit(code ?? 1));
  });
  if (termination) await termination;
  if (outputError || exitCode !== 0) {
    const outputFailure = outputError as Error | null;
    const detail =
      outputFailure?.message || Buffer.concat(stderr).toString("utf8");
    const safe = detail.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1000);
    process.stdout.write(
      frameOutput(
        "ERROR",
        exitCode || 1,
        Buffer.from(safe || "provider failed", "utf8")
      )
    );
  } else {
    process.stdout.write(frameOutput("OK", 0, Buffer.concat(stdout)));
  }
  return stayAlive();
}

const entry = process.argv[1];
if (entry && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  void runBroker(process.argv[2] ?? "");
}
