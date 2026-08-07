import { EventEmitter } from "events";
import type { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { describe, it, expect, vi } from "vitest";

const contextState = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<Record<string, unknown>>,
}));

// Pin resolveBinary to null so buildAskArgs falls back to the BARE name, making
// the argv assertions deterministic and identical on every OS (the real
// resolveBinary would otherwise return an absolute .cmd path on Windows). isWindows
// is left as the real value — buildAskArgs/buildAskPrompt don't read it, and the
// route's spawn (which does) is not exercised here. We never spawn a real agent.
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return { ...actual, resolveBinary: () => null };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: (path: string) => /python(?:3|\.exe)?$/.test(path),
    readFileSync: () =>
      '#!/usr/bin/env bash\nexec "/opt/hermes/venv/bin/python" "/opt/hermes/hermes" "$@"\n',
  };
});

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: { getAllSessions: () => ({ all: () => contextState.sessions }) },
}));
vi.mock("@/lib/analytics/queries", () => ({
  getAnalyticsReport: vi.fn(async () => null),
}));
vi.mock("@/lib/session-status", () => ({
  computeManagedStatuses: vi.fn(async () => contextState.statuses),
}));

import {
  buildAskArgs,
  buildAskPrompt,
  gatherStoaContext,
  parseHermesLauncherPython,
  runAsk,
} from "@/lib/ask";
import { killTreeArgs } from "@/lib/platform";

const PROMPT = "What is happening in my fleet?";

describe("killTreeArgs — Windows process-tree teardown on the ask timeout", () => {
  it("Windows: a `taskkill /T /F` argv so the cmd→shim→node→agent tree dies (not just cmd)", () => {
    expect(killTreeArgs(4242, true)).toEqual([
      "taskkill",
      "/PID",
      "4242",
      "/T",
      "/F",
    ]);
  });

  it("POSIX: null — a plain child.kill() reaps the group", () => {
    expect(killTreeArgs(4242, false)).toBeNull();
  });
});

describe("gatherStoaContext internal-session boundary", () => {
  it("omits server-owned roster and live-screen data", async () => {
    contextState.sessions = [
      {
        id: "visible",
        name: "Visible",
        agent_type: "claude",
        status: "running",
        working_directory: "/repo",
        session_role: "interactive",
      },
      {
        id: "internal",
        name: "Managed supervisor",
        agent_type: "claude",
        status: "running",
        working_directory: "/tmp/internal",
        session_role: "fleet_supervisor",
      },
    ];
    contextState.statuses = [
      {
        id: "visible",
        name: "claude-visible",
        status: "running",
        lastLine: "ordinary output",
        prompt: null,
      },
      {
        id: "internal",
        name: "claude-internal",
        status: "waiting",
        lastLine: "secret broker output",
        prompt: { kind: "continue", line: "approve?" },
      },
    ];

    const context = await gatherStoaContext();

    expect(context).toContain("Visible");
    expect(context).toContain("ordinary output");
    expect(context).not.toContain("Managed supervisor");
    expect(context).not.toContain("secret broker output");
    expect(context).not.toContain("/tmp/internal");
  });
});

describe("buildAskArgs — per-provider non-interactive argv (cross-platform guard)", () => {
  it("resolves the interpreter from the official POSIX Hermes launcher", () => {
    expect(
      parseHermesLauncherPython(
        '#!/usr/bin/env bash\nexec "/opt/hermes/venv/bin/python" "/opt/hermes/hermes" "$@"\n'
      )
    ).toBe("/opt/hermes/venv/bin/python");
    expect(parseHermesLauncherPython('#!/bin/sh\nexec python3 "$@"')).toBeNull;
  });

  it("resolves the interpreter from a Hermes console-script shebang", () => {
    expect(
      parseHermesLauncherPython(
        "#!/opt/hermes/venv/bin/python3\nfrom hermes_cli.main import main\n"
      )
    ).toBe("/opt/hermes/venv/bin/python3");
  });

  it("claude: `claude -p`, prompt on stdin", () => {
    const plan = buildAskArgs("claude", PROMPT);
    expect(plan.binary).toBe("claude");
    expect(plan.args).toEqual(["-p"]);
    // Prompt is piped on stdin, NOT placed in argv.
    expect(plan.input).toBe(PROMPT);
    expect(plan.args).not.toContain(PROMPT);
  });

  it("codex: `codex exec`, prompt on stdin", () => {
    const plan = buildAskArgs("codex", PROMPT);
    expect(plan.binary).toBe("codex");
    expect(plan.args).toEqual(["exec"]);
    expect(plan.input).toBe(PROMPT);
    expect(plan.args).not.toContain(PROMPT);
  });

  it("hermes: tool-free one-shot keeps the prompt on stdin", () => {
    const plan = buildAskArgs("hermes", PROMPT, "kimi-k3");
    expect(plan.binary).toMatch(/python(?:3|\.exe)?$/);
    expect(plan.args[0]).toBe("-c");
    expect(plan.args[1]).toContain("__stoa_no_tools__");
    expect(plan.args[1]).toContain("get_tool_definitions = lambda");
    expect(plan.args[1]).toContain("use_config_toolsets=False");
    expect(plan.args[2]).toBe("kimi-k3");
    expect(plan.args).not.toContain(PROMPT);
    expect(plan.input).toBe(PROMPT);
    expect(plan.shell).toBe(false);
  });

  it("hermes keeps a Windows-sized prompt off argv", () => {
    const largePrompt = `PREAMBLE\n${"fleet-context\n".repeat(4_000)}QUESTION`;
    const plan = buildAskArgs("hermes", largePrompt, "kimi-k3");
    expect(plan.input).toBe(largePrompt);
    expect(plan.args.join(" ")).not.toContain(largePrompt);
  });

  it("claude and codex carry the prompt on STDIN, never in argv", () => {
    // The prompt embeds untrusted fleet context; under shell:isWindows an argv
    // prompt would be command-injectable. So it must always be `input`, never an
    // arg. Hermes is covered separately and also reads stdin without a shell.
    for (const provider of ["claude", "codex"] as const) {
      const plan = buildAskArgs(provider, PROMPT);
      expect(plan.input).toBe(PROMPT);
      expect(plan.args).not.toContain(PROMPT);
    }
  });

  it("never adds a --dangerously-* / bypass flag (read-only Q&A)", () => {
    for (const provider of ["claude", "codex", "hermes"] as const) {
      const { args } = buildAskArgs(provider, PROMPT);
      for (const arg of args) {
        expect(arg).not.toMatch(/dangerous|bypass|yolo|--fork/i);
      }
    }
  });

  it("threads static-provider models into argv with prompts on stdin", () => {
    // The model is a fixed CATALOG token (validated server-side), so it's safe in
    // argv even though the prompt never is.
    const claude = buildAskArgs("claude", PROMPT, "opus");
    expect(claude.args).toEqual(["-p", "--model", "opus"]);
    expect(claude.input).toBe(PROMPT);
    expect(claude.args).not.toContain(PROMPT);

    const codex = buildAskArgs("codex", PROMPT, "gpt-5.4");
    expect(codex.args).toEqual(["exec", "-c", "model=gpt-5.4"]);
    expect(codex.input).toBe(PROMPT);
    expect(codex.args).not.toContain(PROMPT);
  });

  it("uses provider defaults when no model is given", () => {
    expect(buildAskArgs("claude", PROMPT).args).toEqual(["-p"]);
    expect(buildAskArgs("codex", PROMPT).args).toEqual(["exec"]);
    expect(buildAskArgs("hermes", PROMPT).args.at(-1)).toBe("kimi-k3");
  });
});

describe("runAsk stream failures", () => {
  it("rejects and tears down when the prompt pipe emits EPIPE", async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdin = Object.assign(new EventEmitter(), {
      write: vi.fn(() => {
        queueMicrotask(() => stdin.emit("error", new Error("EPIPE")));
        return true;
      }),
      end: vi.fn(),
    });
    const kill = vi.fn();
    Object.assign(child, {
      pid: undefined,
      stdin,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill,
    });
    const spawnChild = vi.fn(() => child) as unknown as typeof spawn;

    await expect(
      runAsk("claude", PROMPT, { timeoutMs: 1_000, spawnChild })
    ).rejects.toThrow("EPIPE");
    expect(kill).toHaveBeenCalled();
  });
});

describe("buildAskPrompt — grounds the question in the gathered context", () => {
  it("includes the preamble, the context, and the question", () => {
    const out = buildAskPrompt({
      context: "FLEET_CONTEXT_MARKER",
      question: "Which sessions need me?",
    });
    expect(out).toContain("Stoa's built-in assistant");
    expect(out).toContain("FLEET_CONTEXT_MARKER");
    expect(out).toContain("Which sessions need me?");
    // The instruction to stay grounded + tool-free must survive.
    expect(out).toMatch(/ONLY the CONTEXT/i);
    expect(out).toMatch(/Do not run commands or use tools/i);
  });

  it("renders prior history turns as labelled User/Assistant lines", () => {
    const out = buildAskPrompt({
      context: "CTX",
      history: [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ],
      question: "follow-up question",
    });
    expect(out).toContain("User: earlier question");
    expect(out).toContain("Assistant: earlier answer");
    expect(out).toContain("follow-up question");
    // History appears before the final question block.
    expect(out.indexOf("earlier question")).toBeLessThan(
      out.indexOf("follow-up question")
    );
  });

  it("omits the history section when no history is given", () => {
    const out = buildAskPrompt({ context: "CTX", question: "q" });
    expect(out).not.toContain("CONVERSATION SO FAR");
  });

  it("sanitizes control bytes out of the question (defense-in-depth)", () => {
    // ESC + CR injected into the question must not survive into the prompt. The
    // control bytes are built from char codes so this source file carries none.
    const ESC = String.fromCharCode(27);
    const CR = String.fromCharCode(13);
    const dirty = "list" + ESC + "[31m" + CR + "sessions";
    const out = buildAskPrompt({ context: "CTX", question: dirty });
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(CR);
    // The visible text still survives — only the control bytes are stripped.
    expect(out).toContain("sessions");
  });
});
