import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  _managedSupervisorResultFrameForTests,
  encodeManagedSupervisorBrokerConfig,
  managedSupervisorBrokerProfile,
  managedSupervisorBrokerHasMarker,
  managedSupervisorClaudeArgs,
  managedSupervisorEnvironment,
  managedSupervisorProfileHash,
  managedSupervisorProfileJson,
  managedSupervisorPromptFrame,
  MANAGED_SUPERVISOR_BROKER_VERSION,
  MANAGED_SUPERVISOR_GROUP_PATH,
  MANAGED_SUPERVISOR_READY,
  MANAGED_SUPERVISOR_STARTED,
  parseManagedSupervisorCapturedOutput,
} from "@/lib/fleet/supervisor-broker";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const brokerPath = resolve("lib/fleet/supervisor-broker.ts");
const fakeProvider = resolve("test/fixtures/fleet-supervisor-provider.cjs");

describe("managed Fleet supervisor broker", () => {
  it("locks Claude to print mode with tools, MCP, settings, slash commands, and persistence disabled", () => {
    expect(managedSupervisorClaudeArgs("sonnet")).toEqual([
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
      "--model",
      "sonnet",
    ]);
    const args = managedSupervisorClaudeArgs("sonnet");
    expect(args.join(" ")).not.toMatch(
      /dangerously|bypass|allow-tools|permission-mode/i
    );
  });

  it("builds a true minimal allowlist without Stoa, MCP, GitHub, cloud, or Node injection credentials", () => {
    const env = managedSupervisorEnvironment({
      PATH: "/bin",
      HOME: "/home/test",
      ANTHROPIC_API_KEY: "anthropic-secret",
      ANTHROPIC_AUTH_TOKEN: "unsupported-auth-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "unsupported-oauth-secret",
      STOA_TOKEN: "stoa-secret",
      STOA_SESSION_ID: "session-secret",
      CONDUCTOR_SESSION_ID: "conductor-secret",
      MCP_SESSION_ID: "mcp-secret",
      DB_PATH: "/authority/stoa.db",
      GITHUB_TOKEN: "github-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/cloud/key.json",
      NODE_OPTIONS: "--require=/tmp/inject.cjs",
    });
    expect(env).toEqual({
      NODE_ENV: "production",
      PATH: "/bin",
      HOME: "/home/test",
      ANTHROPIC_API_KEY: "anthropic-secret",
    });
  });

  it("hashes an exact immutable no-tools launch profile", () => {
    const profile = managedSupervisorBrokerProfile(
      {
        schemaVersion: MANAGED_SUPERVISOR_BROKER_VERSION,
        binary: process.execPath,
        argsPrefix: [fakeProvider],
        model: "sonnet",
      },
      {
        backendKey: "claude-supervisor-session",
        workingDirectory: resolve("."),
        groupPath: MANAGED_SUPERVISOR_GROUP_PATH,
        projectId: null,
      }
    );
    const json = managedSupervisorProfileJson(profile);
    expect(profile).toMatchObject({
      role: "fleet_supervisor",
      provider: "claude",
      approvalMode: "prompt",
      tools: "none",
      mcp: "none",
      sessionPersistence: false,
    });
    expect(managedSupervisorProfileHash(json)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("parses only complete integrity-framed bounded output", () => {
    const frame = _managedSupervisorResultFrameForTests('{"ok":true}');
    expect(parseManagedSupervisorCapturedOutput(frame)).toEqual({
      state: "complete",
      text: '{"ok":true}',
      bytes: 11,
    });
    expect(
      parseManagedSupervisorCapturedOutput(
        frame.slice(0, frame.indexOf("STOA_FLEET_SUPERVISOR_V1_END"))
      )
    ).toEqual({ state: "pending" });
    expect(
      parseManagedSupervisorCapturedOutput(frame.replace("eyJv", "eyJx"))
    ).toMatchObject({
      state: "invalid",
      error: expect.stringMatching(/integrity/),
    });
    expect(
      parseManagedSupervisorCapturedOutput(
        _managedSupervisorResultFrameForTests("provider failed", {
          status: "ERROR",
          exitCode: 2,
        })
      )
    ).toEqual({
      state: "invalid",
      error: "managed supervisor provider exited with code 2",
    });
  });

  it("delivers the prompt on stdin, emits framed stdout, and passes the exact locked argv/environment", async () => {
    const config = encodeManagedSupervisorBrokerConfig({
      schemaVersion: MANAGED_SUPERVISOR_BROKER_VERSION,
      binary: process.execPath,
      argsPrefix: [fakeProvider],
      model: "sonnet",
    });
    const child = spawn(process.execPath, [tsxCli, brokerPath, config], {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
      env: managedSupervisorEnvironment({
        ...process.env,
        ANTHROPIC_API_KEY: "anthropic-secret",
        STOA_TOKEN: "must-not-reach-provider",
        GITHUB_TOKEN: "must-not-reach-provider",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    try {
      await expect
        .poll(() =>
          managedSupervisorBrokerHasMarker(output, MANAGED_SUPERVISOR_READY)
        )
        .toBe(true);
      child.stdin.write(`${managedSupervisorPromptFrame("bounded prompt")}\r`);
      await expect
        .poll(() =>
          managedSupervisorBrokerHasMarker(output, MANAGED_SUPERVISOR_STARTED)
        )
        .toBe(true);
      await expect
        .poll(() => parseManagedSupervisorCapturedOutput(output), {
          timeout: 10_000,
        })
        .toMatchObject({ state: "complete" });
      const captured = parseManagedSupervisorCapturedOutput(output);
      expect(captured.state).toBe("complete");
      if (captured.state !== "complete") return;
      const result = JSON.parse(captured.text) as {
        argv: string[];
        input: string;
        inheritedStoaToken: string | null;
        inheritedGithubToken: string | null;
        anthropicKey: string | null;
      };
      expect(result.argv).toEqual(managedSupervisorClaudeArgs("sonnet"));
      expect(result.input).toBe("bounded prompt");
      expect(result.inheritedStoaToken).toBeNull();
      expect(result.inheritedGithubToken).toBeNull();
      expect(result.anthropicKey).toBe("anthropic-secret");
      expect(stderr).toBe("");
    } finally {
      child.kill();
    }
  });

  it("reaps the provider process tree when bounded output is exceeded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stoa-supervisor-reap-"));
    const marker = join(dir, "orphan.txt");
    const config = encodeManagedSupervisorBrokerConfig({
      schemaVersion: MANAGED_SUPERVISOR_BROKER_VERSION,
      binary: process.execPath,
      argsPrefix: [fakeProvider],
      model: "sonnet",
    });
    const child = spawn(process.execPath, [tsxCli, brokerPath, config], {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
      env: managedSupervisorEnvironment({
        ...process.env,
        ANTHROPIC_API_KEY: "anthropic-secret",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    try {
      await expect
        .poll(() =>
          managedSupervisorBrokerHasMarker(output, MANAGED_SUPERVISOR_READY)
        )
        .toBe(true);
      child.stdin.write(
        `${managedSupervisorPromptFrame(`TREE_REAP:${marker}`)}\r`
      );
      await expect
        .poll(() => parseManagedSupervisorCapturedOutput(output), {
          timeout: 10_000,
        })
        .toMatchObject({ state: "invalid" });
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1_800));
      expect(existsSync(marker)).toBe(false);
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
