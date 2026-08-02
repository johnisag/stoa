import { describe, it, expect, beforeEach, vi } from "vitest";

// Capture every command TmuxBackend shells out, with canned stdout for reads.
// This locks the macOS/Linux tmux command construction (exact strings +
// escaping) without needing a real tmux binary, so it runs on every OS in CI.
const { execCalls, execFileCalls } = vi.hoisted(() => ({
  execCalls: [] as string[],
  execFileCalls: [] as Array<{ file: string; args: string[] }>,
}));

vi.mock("child_process", () => ({
  exec: (cmd: string, optsOrCb: unknown, cb?: unknown) => {
    const callback = (typeof optsOrCb === "function" ? optsOrCb : cb) as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    execCalls.push(cmd);
    let stdout = "";
    if (cmd.includes("list-sessions") && cmd.includes("session_activity")) {
      stdout = "claude-1\t1700000000\ncodex-2\t1700000005\n";
    } else if (cmd.includes("list-sessions")) {
      stdout = "claude-1\ncodex-2\n";
    } else if (cmd.includes("pane_pid")) {
      stdout = "4242\n";
    } else if (cmd.includes("display-message")) {
      stdout = "/Users/me/proj\n";
    } else if (cmd.includes("show-environment")) {
      stdout = "CLAUDE_SESSION_ID=abc-123\n";
    } else if (cmd.includes("capture-pane")) {
      stdout = "rendered screen\n";
    }
    callback(null, { stdout, stderr: "" });
  },
  execFileSync: () => {
    throw new Error("tmux absent in test path");
  },
  execFile: (file: string, args: string[], optsOrCb: unknown, cb?: unknown) => {
    const callback = (typeof optsOrCb === "function" ? optsOrCb : cb) as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    execFileCalls.push({ file, args });
    callback(null, { stdout: "", stderr: "" });
  },
}));

import {
  TmuxBackend,
  tmuxSupportsNewSessionEnvironment,
} from "@/lib/session-backend/tmux-backend";

const tb = new TmuxBackend(async () => true);
const last = () => execCalls[execCalls.length - 1];
const lastExecFile = () => execFileCalls[execFileCalls.length - 1];
beforeEach(() => {
  execCalls.length = 0;
  execFileCalls.length = 0;
});

describe("TmuxBackend command construction (macOS/Linux path)", () => {
  it.each([
    ["tmux 2.9a", false],
    ["tmux 3.0a", false],
    ["tmux 3.1c", false],
    ["tmux 3.2", true],
    ["tmux 3.2a", true],
    ["tmux 4.0", true],
    ["vendor build", false],
  ])("detects new-session -e support from %s", (version, supported) => {
    expect(tmuxSupportsNewSessionEnvironment(version)).toBe(supported);
  });

  it("create: mouse + new-session use argv tokens, with ~ expanded before tmux", async () => {
    await tb.create({
      name: "claude-1",
      cwd: "~/proj",
      command: "claude --foo",
    });
    expect(execFileCalls).toEqual([
      { file: "tmux", args: ["set", "-g", "mouse", "on"] },
      {
        file: "tmux",
        args: [
          "new-session",
          "-d",
          "-s",
          "claude-1",
          "-c",
          expect.stringMatching(/[\\/]proj$/),
          "claude --foo",
        ],
      },
    ]);
    expect(execCalls).toHaveLength(0);
  });

  it("create: hostile cwd and command remain argv data, not shell syntax", async () => {
    const cwd = String.raw`/tmp/repo" ; touch /tmp/pwn #`;
    const command = String.raw`bash /tmp/stoa"$(touch /tmp/pwn)`.trim();
    await tb.create({ name: 'a$b`c"d\\e', cwd, command });

    expect(execCalls).toHaveLength(0);
    expect(execFileCalls[1]).toEqual({
      file: "tmux",
      args: ["new-session", "-d", "-s", 'a$b`c"d\\e', "-c", cwd, command],
    });
  });

  it("create: conductor environment is passed as tmux argv data", async () => {
    const hostile = String.raw`session$(touch /tmp/pwn);"value`;
    await tb.create({
      name: "conductor-1",
      cwd: "/repo",
      command: "claude",
      env: { STOA_CONDUCTOR_SESSION_ID: hostile },
    });

    expect(execCalls).toHaveLength(0);
    expect(execFileCalls[1]).toEqual({
      file: "tmux",
      args: [
        "new-session",
        "-d",
        "-s",
        "conductor-1",
        "-c",
        "/repo",
        "-e",
        `STOA_CONDUCTOR_SESSION_ID=${hostile}`,
        "claude",
      ],
    });
  });

  it("create: empty authority overlays are preserved as explicit tmux env clears", async () => {
    await tb.create({
      name: "advisory-1",
      cwd: "/repo",
      command: "claude",
      env: {
        STOA_TOKEN: "",
        CONDUCTOR_SESSION_ID: "",
        DB_PATH: "",
      },
    });

    expect(execFileCalls[1]?.args).toEqual([
      "new-session",
      "-d",
      "-s",
      "advisory-1",
      "-c",
      "/repo",
      "-e",
      "STOA_TOKEN=",
      "-e",
      "CONDUCTOR_SESSION_ID=",
      "-e",
      "DB_PATH=",
      "claude",
    ]);
  });

  it("create: replacement env keeps values out of the shell command", async () => {
    const secret = String.raw`sk-ant-$(touch /tmp/nope);"'value`;
    await tb.create({
      name: "supervisor-1",
      cwd: "/repo",
      command: "ignored legacy command",
      binary: "/usr/local/bin/node",
      args: ["/app/broker.js", "arg'quoted"],
      env: { PATH: "/usr/local/bin:/usr/bin", ANTHROPIC_API_KEY: secret },
      envMode: "replace",
    });

    const createArgs = execFileCalls[1]?.args ?? [];
    expect(createArgs).toContain(`ANTHROPIC_API_KEY=${secret}`);
    const shellCommand = createArgs.at(-1) ?? "";
    expect(shellCommand).toBe(
      `exec 'env' -i PATH="$PATH" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" '/usr/local/bin/node' '/app/broker.js' 'arg'\\''quoted'`
    );
    expect(shellCommand).not.toContain(secret);
    expect(shellCommand).not.toContain("ignored legacy command");
  });

  it("create: pre-3.2 tmux sets env by argv before securely respawning", async () => {
    const legacyTb = new TmuxBackend(async () => false);
    const secret = String.raw`sk-ant-$(touch /tmp/nope);"'value`;
    await legacyTb.create({
      name: "legacy-supervisor",
      cwd: "/repo",
      command: "ignored legacy command",
      binary: "/usr/local/bin/node",
      args: ["/app/broker.js", "arg'quoted"],
      env: { PATH: "/usr/local/bin:/usr/bin", ANTHROPIC_API_KEY: secret },
      envMode: "replace",
    });

    expect(execCalls).toHaveLength(0);
    expect(execFileCalls).toEqual([
      { file: "tmux", args: ["set", "-g", "mouse", "on"] },
      {
        file: "tmux",
        args: [
          "new-session",
          "-d",
          "-s",
          "legacy-supervisor",
          "-c",
          "/repo",
          expect.stringMatching(
            /^exec 'env' -i '.+' -e 'setInterval\(\(\) => \{\}, 2147483647\)'$/
          ),
        ],
      },
      {
        file: "tmux",
        args: [
          "set-environment",
          "-t",
          "legacy-supervisor",
          "PATH",
          "/usr/local/bin:/usr/bin",
        ],
      },
      {
        file: "tmux",
        args: [
          "set-environment",
          "-t",
          "legacy-supervisor",
          "ANTHROPIC_API_KEY",
          secret,
        ],
      },
      {
        file: "tmux",
        args: [
          "respawn-pane",
          "-k",
          "-t",
          "legacy-supervisor",
          "-c",
          "/repo",
          `exec 'env' -i PATH="$PATH" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" '/usr/local/bin/node' '/app/broker.js' 'arg'\\''quoted'`,
        ],
      },
    ]);
    expect(execFileCalls[1]?.args.join(" ")).not.toContain(secret);
    expect(execFileCalls.at(-1)?.args.join(" ")).not.toContain(secret);
  });

  it("create: replacement env requires structured argv and safe variable names", async () => {
    await expect(
      tb.create({
        name: "supervisor-no-binary",
        cwd: "/repo",
        command: "node broker.js",
        envMode: "replace",
      })
    ).rejects.toThrow("require structured binary/args");
    await expect(
      tb.create({
        name: "supervisor-bad-env",
        cwd: "/repo",
        command: "",
        binary: "node",
        env: { "BAD-NAME": "value" },
        envMode: "replace",
      })
    ).rejects.toThrow("Invalid environment variable name");
    expect(execFileCalls).toHaveLength(0);
  });

  it("capture: visible screen vs N scrollback lines", async () => {
    await tb.capture("claude-1");
    expect(last()).toBe('tmux capture-pane -t "claude-1" -p 2>/dev/null');
    await tb.capture("claude-1", { lines: 100 });
    expect(last()).toBe(
      'tmux capture-pane -t "claude-1" -p -S -100 2>/dev/null'
    );
  });

  it("sendKeysLiteral: POSIX single-quote escaping", async () => {
    await tb.sendKeysLiteral("claude-1", "it's a test");
    expect(last()).toBe(`tmux send-keys -t "claude-1" -l 'it'\\''s a test'`);
  });

  it('sendKeysInterpreted: escapes " and $, appends Enter', async () => {
    await tb.sendKeysInterpreted("claude-1", 'say "hi" $x', { enter: true });
    expect(last()).toBe(
      'tmux send-keys -t "claude-1" "say \\"hi\\" \\$x" Enter'
    );
  });

  it("kill / rename / sendEnter / exists", async () => {
    await tb.kill("claude-1");
    expect(last()).toBe('tmux kill-session -t "claude-1" 2>/dev/null || true');
    await tb.rename("a", "b");
    expect(last()).toBe('tmux rename-session -t "a" "b"');
    await tb.sendEnter("claude-1");
    expect(last()).toBe('tmux send-keys -t "claude-1" Enter');
    await tb.sendEscape("claude-1");
    expect(last()).toBe('tmux send-keys -t "claude-1" Escape');
    expect(await tb.exists("claude-1")).toBe(true);
  });

  it("list / listWithActivity / getPanePath / getEnv parse tmux output", async () => {
    expect(await tb.list()).toEqual(["claude-1", "codex-2"]);
    expect(await tb.listWithActivity()).toEqual([
      { name: "claude-1", activity: 1700000000 },
      { name: "codex-2", activity: 1700000005 },
    ]);
    expect(await tb.getPanePath("claude-1")).toBe("/Users/me/proj");
    expect(await tb.getEnv("claude-1", "CLAUDE_SESSION_ID")).toBe("abc-123");
  });

  it("getPid: display-message '#{pane_pid}', parsed to a positive int (M3)", async () => {
    const pid = await tb.getPid("claude-1");
    expect(last()).toBe(
      'tmux display-message -t "claude-1" -p "#{pane_pid}" 2>/dev/null || echo ""'
    );
    expect(pid).toBe(4242);
  });

  it("pasteText: load-buffer/paste-buffer/delete-buffer then Enter", async () => {
    await tb.pasteText("claude-1", "multi\nline", { enter: true });
    const joined = execCalls.join("\n");
    expect(joined).toMatch(/tmux load-buffer -b "send-[\w-]+" ".*"/);
    expect(joined).toMatch(/tmux paste-buffer -b "send-[\w-]+" -t "claude-1"/);
    expect(joined).toMatch(/tmux delete-buffer -b "send-[\w-]+"/);
    expect(last()).toBe('tmux send-keys -t "claude-1" Enter');
  });
});
