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

import { TmuxBackend } from "@/lib/session-backend/tmux-backend";

const tb = new TmuxBackend();
const last = () => execCalls[execCalls.length - 1];
const lastExecFile = () => execFileCalls[execFileCalls.length - 1];
beforeEach(() => {
  execCalls.length = 0;
  execFileCalls.length = 0;
});

describe("TmuxBackend command construction (macOS/Linux path)", () => {
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
