import { describe, it, expect } from "vitest";
import {
  buildAgentArgs,
  shellQuoteArg,
  escapeForDoubleQuotes,
  buildTmuxFlags,
} from "@/lib/providers";

describe("buildAgentArgs", () => {
  it("claude: plain launch has no args", () => {
    const { binary, args } = buildAgentArgs("claude", {});
    expect(binary).toBe("claude");
    expect(args).toEqual([]);
  });

  it("claude: auto-approve adds the skip-permissions flag", () => {
    const { args } = buildAgentArgs("claude", { autoApprove: true });
    expect(args).toEqual(["--dangerously-skip-permissions"]);
  });

  it("claude: resume splits into discrete argv tokens (no combined string)", () => {
    const { args } = buildAgentArgs("claude", { sessionId: "abc-123" });
    expect(args).toEqual(["--resume", "abc-123"]);
  });

  it("claude: fork from parent adds --fork-session", () => {
    const { args } = buildAgentArgs("claude", { parentSessionId: "parent-9" });
    expect(args).toEqual(["--resume", "parent-9", "--fork-session"]);
  });

  it("claude: initial prompt is a single raw positional arg (no quoting)", () => {
    const prompt = `hello "world" with $pace and 'quotes'`;
    const { args } = buildAgentArgs("claude", { initialPrompt: prompt });
    expect(args).toEqual([prompt]);
    // The prompt must be exactly one argv entry — no shell escaping injected.
    expect(args).toHaveLength(1);
  });

  it("codex: auto-approve flag, model flag, positional prompt", () => {
    const { binary, args } = buildAgentArgs("codex", {
      autoApprove: true,
      model: "o3",
      initialPrompt: "go",
    });
    expect(binary).toBe("codex");
    expect(args).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "o3",
      "go",
    ]);
  });

  it("hermes: --yolo + free-text model via -m; prompt still not wired", () => {
    expect(buildAgentArgs("hermes", {}).args).toEqual([]);
    const { binary, args } = buildAgentArgs("hermes", {
      autoApprove: true,
      model: "anthropic/claude-sonnet-4.6", // dynamic/free-text → passed via -m
      initialPrompt: "ignored until -z semantics confirmed",
    });
    expect(binary).toBe("hermes");
    expect(args).toEqual(["--yolo", "-m", "anthropic/claude-sonnet-4.6"]);
    // empty model must not append -m (Hermes falls back to its own default)
    expect(
      buildAgentArgs("hermes", { autoApprove: true, model: "" }).args
    ).toEqual(["--yolo"]);
  });

  it("hermes: resume passes --resume <id> as discrete tokens (banner-captured id)", () => {
    const sid = "20260531_133925_98d9fc";
    expect(buildAgentArgs("hermes", { sessionId: sid }).args).toEqual([
      "--resume",
      sid,
    ]);
    // flag ordering with auto-approve
    expect(
      buildAgentArgs("hermes", { autoApprove: true, sessionId: sid }).args
    ).toEqual(["--yolo", "--resume", sid]);
    // best-effort: a falsy/empty id must not append --resume (mustn't break spawn)
    expect(buildAgentArgs("hermes", { sessionId: "" }).args).toEqual([]);
    expect(buildAgentArgs("hermes", { sessionId: null }).args).toEqual([]);
    // Hermes has no --fork-session: a parentSessionId resumes but never forks
    expect(buildAgentArgs("hermes", { parentSessionId: sid }).args).toEqual([
      "--resume",
      sid,
    ]);
  });

  it("kilo: fresh launch emits --model <free-text>", () => {
    const { binary, args } = buildAgentArgs("kilo", {
      model: "anthropic/claude-opus-4.8",
    });
    expect(binary).toBe("kilo");
    expect(args).toEqual(["--model", "anthropic/claude-opus-4.8"]);
    // empty model must not append --model (Kilo falls back to its own default)
    expect(buildAgentArgs("kilo", { model: "" }).args).toEqual([]);
  });

  it("kimi: fresh launch emits --yolo -m <free-text>", () => {
    const { binary, args } = buildAgentArgs("kimi", {
      autoApprove: true,
      model: "kimi-k2",
    });
    expect(binary).toBe("kimi");
    expect(args).toEqual(["--yolo", "-m", "kimi-k2"]);
    // empty model must not append -m (Kimi falls back to its own default)
    expect(
      buildAgentArgs("kimi", { autoApprove: true, model: "" }).args
    ).toEqual(["--yolo"]);
  });

  it("kimi: resume emits --session <id> as discrete tokens", () => {
    const id = "session_ca9b5a60-f6da-47f8-b2fa-84805e8c8161";
    expect(buildAgentArgs("kimi", { sessionId: id }).args).toEqual([
      "--session",
      id,
    ]);
    expect(
      buildAgentArgs("kimi", { autoApprove: true, sessionId: id }).args
    ).toEqual(["--yolo", "--session", id]);
    expect(buildAgentArgs("kimi", { sessionId: "" }).args).toEqual([]);
    expect(buildAgentArgs("kimi", { sessionId: null }).args).toEqual([]);
  });

  it("shell: empty binary (server spawns a plain shell)", () => {
    const { binary, args } = buildAgentArgs("shell", {});
    expect(binary).toBe("");
    expect(args).toEqual([]);
  });

  it("codex: conductor extraArgs pass through as clean tokens", () => {
    const extra = ["-c", "mcp_servers.stoa.command='npx'"];
    const { args } = buildAgentArgs("codex", {
      autoApprove: true,
      extraArgs: extra,
    });
    expect(args).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      ...extra,
    ]);
  });

  it("codex: extraArgs come BEFORE the positional prompt", () => {
    const { args } = buildAgentArgs("codex", {
      extraArgs: ["-c", "x=1"],
      initialPrompt: "do the thing",
    });
    expect(args).toEqual(["-c", "x=1", "do the thing"]);
  });
});

describe("shellQuoteArg — tmux exec quoting for conductor tokens", () => {
  it("passes word-safe tokens through unquoted", () => {
    expect(shellQuoteArg("-c")).toBe("-c");
    expect(shellQuoteArg("--model")).toBe("--model");
  });

  it("double-quotes tokens with TOML literals / brackets / commas", () => {
    const token = "mcp_servers.stoa.args=['tsx','/p/x.ts']";
    expect(shellQuoteArg(token)).toBe(`"${token}"`);
    // Single quotes survive literally inside the double quotes.
    expect(shellQuoteArg("mcp_servers.stoa.command='npx'")).toBe(
      `"mcp_servers.stoa.command='npx'"`
    );
  });

  it("escapes shell-significant chars when quoting", () => {
    expect(shellQuoteArg('a"b')).toBe('"a\\"b"');
    expect(shellQuoteArg("a$b")).toBe('"a\\$b"');
  });
});

describe("escapeForDoubleQuotes — containment inside an outer double-quoted shell string", () => {
  // The single source for double-quote escaping (shellQuoteArg's inner escape AND
  // the tmux init-script fallback in app/page.tsx). Locks the exact char-class so a
  // future tweak can't silently re-open the tmux command-injection.
  it('escapes ONLY the chars active inside double quotes (\\ " $ `)', () => {
    expect(escapeForDoubleQuotes('a"b')).toBe('a\\"b');
    expect(escapeForDoubleQuotes("a$b")).toBe("a\\$b");
    expect(escapeForDoubleQuotes("a\\b")).toBe("a\\\\b");
    expect(escapeForDoubleQuotes("a`b")).toBe("a\\`b");
    // A command-substitution payload: $ is escaped so the outer shell can't run it.
    expect(escapeForDoubleQuotes("$(touch /tmp/x)")).toBe("\\$(touch /tmp/x)");
  });

  it("leaves chars that are INERT inside double quotes untouched", () => {
    // ; ~ | & * spaces ' are all literal inside double quotes — no escaping needed.
    expect(escapeForDoubleQuotes("evil; rm -rf ~ | x & *")).toBe(
      "evil; rm -rf ~ | x & *"
    );
    expect(escapeForDoubleQuotes("hermes -m opus 'fix the bug'")).toBe(
      "hermes -m opus 'fix the bug'"
    );
    // `!` is deliberately NOT escaped: in double quotes `\!` keeps the backslash,
    // so escaping it would corrupt benign prompts (non-interactive shells don't
    // history-expand). Lock that invariant.
    expect(escapeForDoubleQuotes("done!")).toBe("done!");
  });
});

describe("buildTmuxFlags — conductor extraArgs ordering on the tmux path (F7)", () => {
  it("splices extraArgs BEFORE a trailing positional prompt (matches the pty path)", () => {
    // Codex buildFlags emits the prompt last; the -c wiring must precede it.
    const base = ["--dangerously-bypass-approvals-and-sandbox", "'do it'"];
    const extra = ["-c", "x=1"];
    expect(buildTmuxFlags(base, extra, true)).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "x=1",
      "'do it'",
    ]);
  });

  it("appends extraArgs when there's no trailing prompt", () => {
    expect(buildTmuxFlags(["--flag"], ["-c", "x=1"], false)).toEqual([
      "--flag",
      "-c",
      "x=1",
    ]);
  });

  it("returns baseFlags untouched when there are no extraArgs (non-conductor)", () => {
    const base = ["--model", "o3", "'go'"];
    expect(buildTmuxFlags(base, [], true)).toBe(base);
  });

  it("appends when a prompt is claimed but baseFlags is empty (defensive)", () => {
    expect(buildTmuxFlags([], ["-c", "x=1"], true)).toEqual(["-c", "x=1"]);
  });
});
