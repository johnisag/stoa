import { describe, it, expect } from "vitest";
import {
  getProvider,
  getAllProviders,
  isValidAgentType,
  buildAgentArgs,
  shellQuoteArg,
  parseMcpLaunchArgs,
} from "@/lib/providers";
import {
  PROVIDER_IDS,
  getAllProviderDefinitions,
  getProviderDefinition,
  getManagedSessionPattern,
  getProviderIdFromSessionName,
  getSessionIdFromName,
  isValidProviderId,
  sessionKey,
  backendKeyForSession,
} from "@/lib/providers/registry";
import { AGENT_OPTIONS } from "@/components/NewSessionDialog/NewSessionDialog.types";
import { isFreeTextModelAgent, getModelOptions } from "@/lib/model-catalog";

describe("parseMcpLaunchArgs — the single mcp_launch_args parser", () => {
  it("parses a JSON string-array into clean tokens", () => {
    const raw = JSON.stringify(["-c", "mcp_servers.stoa.command=stoa"]);
    expect(parseMcpLaunchArgs(raw)).toEqual([
      "-c",
      "mcp_servers.stoa.command=stoa",
    ]);
  });

  it("coerces non-string array entries to strings", () => {
    expect(parseMcpLaunchArgs(JSON.stringify(["-c", 42]))).toEqual([
      "-c",
      "42",
    ]);
  });

  it("returns [] for null/empty/malformed/non-array (spawn proceeds, no flags)", () => {
    expect(parseMcpLaunchArgs(null)).toEqual([]);
    expect(parseMcpLaunchArgs(undefined)).toEqual([]);
    expect(parseMcpLaunchArgs("")).toEqual([]);
    expect(parseMcpLaunchArgs("{not json")).toEqual([]);
    expect(parseMcpLaunchArgs(JSON.stringify({ not: "an array" }))).toEqual([]);
  });

  it("feeds buildAgentArgs as extraArgs (before the positional prompt)", () => {
    const extraArgs = parseMcpLaunchArgs(
      JSON.stringify(["-c", "mcp_servers.stoa.x=y"])
    );
    const { args } = buildAgentArgs("codex", {
      extraArgs,
      initialPrompt: "do it",
    });
    const ci = args.indexOf("-c");
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(args[ci + 1]).toBe("mcp_servers.stoa.x=y");
    // Conductor wiring lands before the positional prompt.
    expect(ci).toBeLessThan(args.indexOf("do it"));
  });
});

describe("Hermes provider wiring", () => {
  it("has the expected registry definition", () => {
    const def = getProviderDefinition("hermes");
    expect(def.cli).toBe("hermes");
    expect(def.autoApproveFlag).toBe("--yolo");
    expect(def.resumeFlag).toBe("--resume");
    expect(def.supportsResume).toBe(true); // resume on via banner session-id capture
    expect(def.supportsFork).toBe(false); // Hermes has no --fork-session
    expect(def.modelFlag).toBe("-m"); // dynamic models passed as free-text via -m
  });

  it("has a provider object whose buildFlags emits --yolo only on auto-approve", () => {
    const p = getProvider("hermes");
    expect(p.command).toBe("hermes");
    expect(p.supportsResume).toBe(true); // lockstep with the registry definition
    expect(p.buildFlags({})).toEqual([]);
    expect(p.buildFlags({ autoApprove: true })).toEqual(["--yolo"]);
    expect(p.buildFlags({ skipPermissions: true })).toEqual(["--yolo"]);
  });

  it("buildFlags (tmux path) resumes from a banner-captured session id, like claude", () => {
    const p = getProvider("hermes");
    const id = "20260531_133925_98d9fc";
    expect(p.buildFlags({ sessionId: id })).toEqual([`--resume ${id}`]);
    expect(p.buildFlags({ autoApprove: true, sessionId: id })).toEqual([
      "--yolo",
      `--resume ${id}`,
    ]);
  });

  it("builds argv with --yolo + free-text model via -m; prompt still not wired", () => {
    const { binary, args } = buildAgentArgs("hermes", {
      autoApprove: true,
      model: "anthropic/claude-opus-4.8",
      initialPrompt: "hi", // still ignored (initialPromptFlag unset)
    });
    expect(binary).toBe("hermes");
    expect(args).toEqual(["--yolo", "-m", "anthropic/claude-opus-4.8"]);
  });

  it("is a valid agent type and appears in the New Session picker", () => {
    expect(isValidProviderId("hermes")).toBe(true);
    expect(isValidAgentType("hermes")).toBe(true);
    expect(AGENT_OPTIONS.some((o) => o.value === "hermes")).toBe(true);
  });

  it("is matched by the managed-session name pattern", () => {
    const re = getManagedSessionPattern();
    expect(re.test("hermes-12345678-1234-1234-1234-123456789abc")).toBe(true);
  });
});

describe("Claude provider wiring", () => {
  it("takes --model (alias or full id) so the picker drives the launch model", () => {
    expect(getProviderDefinition("claude").modelFlag).toBe("--model");
    const { args } = buildAgentArgs("claude", { model: "opus" });
    expect(args).toEqual(["--model", "opus"]);
  });

  // The picker must work on BOTH backends. The pty path (buildAgentArgs) and the
  // tmux path (provider.buildFlags) have to emit the model identically, or the
  // feature silently becomes Windows-only (tmux is the default on macOS/Linux).
  it("buildFlags (tmux path) emits the model on a fresh launch, like the pty path", () => {
    expect(getProvider("claude").buildFlags({ model: "opus" })).toEqual([
      "--model opus",
    ]);
  });

  it("does NOT re-pass --model when resuming — Claude restores the session's own model", () => {
    // Re-asserting would override the running session's model (notably an older
    // row that stored the previously-inert default). Both spawn paths must agree.
    expect(
      buildAgentArgs("claude", {
        model: "opus",
        sessionId: "abc-123",
        autoApprove: true,
      }).args
    ).toEqual(["--dangerously-skip-permissions", "--resume", "abc-123"]);
    expect(
      getProvider("claude").buildFlags({ model: "opus", sessionId: "abc-123" })
    ).toEqual(["--resume abc-123"]);
  });

  it("does NOT re-pass --model when forking either (the fork inherits its model)", () => {
    expect(
      buildAgentArgs("claude", { model: "opus", parentSessionId: "p1" }).args
    ).toEqual(["--resume", "p1", "--fork-session"]);
    // tmux path agrees
    expect(
      getProvider("claude").buildFlags({ model: "opus", parentSessionId: "p1" })
    ).toEqual(["--resume p1", "--fork-session"]);
  });

  // restoresModelOnResume is Claude-only. Hermes (which also resumes) must STILL
  // re-assert -m on resume — locking the one non-Claude combination that now
  // routes through shouldPassModel, so a wrong gate can't silently drop it.
  it("Hermes still passes -m alongside --resume (restoresModelOnResume unset)", () => {
    const id = "20260531_133925_98d9fc";
    expect(
      buildAgentArgs("hermes", { model: "anthropic/x", sessionId: id }).args
    ).toEqual(["-m", "anthropic/x", "--resume", id]);
    expect(
      getProvider("hermes").buildFlags({ model: "anthropic/x", sessionId: id })
    ).toEqual([`--resume ${id}`, "-m anthropic/x"]);
  });
});

describe("Kilo provider wiring", () => {
  it("has the expected registry definition (free-text model, no auto-approve on the TUI)", () => {
    const def = getProviderDefinition("kilo");
    expect(def.cli).toBe("kilo");
    // The bare TUI has no auto-approve flag (`--auto` is a `kilo run` flag).
    expect(def.autoApproveFlag).toBeUndefined();
    expect(def.resumeFlag).toBe("--session");
    expect(def.supportsResume).toBe(false); // fresh-launch-only (id-capture is a follow-up)
    expect(def.supportsFork).toBe(false);
    expect(def.modelFlag).toBe("--model"); // free-text provider/model via --model
    // Free-text agent → no static model catalog leaks in (drops foreign models).
    expect(isFreeTextModelAgent("kilo")).toBe(true);
    expect(getModelOptions("kilo")).toEqual([]);
  });

  it("has a provider object whose buildFlags emits nothing without options (no auto-approve)", () => {
    const p = getProvider("kilo");
    expect(p.command).toBe("kilo");
    expect(p.supportsResume).toBe(false); // lockstep with the registry definition
    // No autoApproveFlag, so even skipPermissions/autoApprove emit nothing.
    expect(p.buildFlags({})).toEqual([]);
    expect(p.buildFlags({ autoApprove: true })).toEqual([]);
    expect(p.buildFlags({ skipPermissions: true })).toEqual([]);
  });

  // The picker must work on BOTH backends — the pty path (buildAgentArgs) and the
  // tmux path (buildFlags) have to emit the free-text model identically.
  it("emits the free-text model on a fresh launch on BOTH the pty and tmux paths", () => {
    const { binary, args } = buildAgentArgs("kilo", {
      model: "anthropic/claude-opus-4.8",
    });
    expect(binary).toBe("kilo");
    expect(args).toEqual(["--model", "anthropic/claude-opus-4.8"]);
    expect(
      getProvider("kilo").buildFlags({ model: "anthropic/claude-opus-4.8" })
    ).toEqual(["--model anthropic/claude-opus-4.8"]);
  });

  it("is fresh-launch-only for now (resume/fork off until session-id capture is wired)", () => {
    expect(getProviderDefinition("kilo").supportsResume).toBe(false);
    expect(getProviderDefinition("kilo").supportsFork).toBe(false);
  });

  it("is a valid agent type and appears in the New Session picker", () => {
    expect(isValidProviderId("kilo")).toBe(true);
    expect(isValidAgentType("kilo")).toBe(true);
    expect(AGENT_OPTIONS.some((o) => o.value === "kilo")).toBe(true);
  });
});

describe("Kimi provider wiring", () => {
  it("has the expected registry definition (free-text model, --yolo auto-approve)", () => {
    const def = getProviderDefinition("kimi");
    expect(def.cli).toBe("kimi");
    expect(def.autoApproveFlag).toBe("--yolo");
    expect(def.resumeFlag).toBe("--session");
    expect(def.supportsResume).toBe(true); // resume via on-disk session_index.jsonl
    expect(def.supportsFork).toBe(false); // no fork on the bare TUI
    expect(def.modelFlag).toBe("-m"); // free-text model alias via -m
    expect(isFreeTextModelAgent("kimi")).toBe(true);
    expect(getModelOptions("kimi")).toEqual([]);
  });

  it("has a provider object whose buildFlags emits --yolo only on auto-approve", () => {
    const p = getProvider("kimi");
    expect(p.command).toBe("kimi");
    expect(p.supportsResume).toBe(true); // lockstep with the registry definition
    expect(p.buildFlags({})).toEqual([]);
    expect(p.buildFlags({ autoApprove: true })).toEqual(["--yolo"]);
    expect(p.buildFlags({ skipPermissions: true })).toEqual(["--yolo"]);
  });

  it("emits --yolo + the free-text model on a fresh launch on BOTH the pty and tmux paths", () => {
    const { binary, args } = buildAgentArgs("kimi", {
      autoApprove: true,
      model: "kimi-k2",
      initialPrompt: "hi", // still ignored (initialPromptFlag unset)
    });
    expect(binary).toBe("kimi");
    expect(args).toEqual(["--yolo", "-m", "kimi-k2"]);
    expect(
      getProvider("kimi").buildFlags({ autoApprove: true, model: "kimi-k2" })
    ).toEqual(["--yolo", "-m kimi-k2"]);
  });

  it("resumes via --session <id> on both paths (id captured from the startup banner)", () => {
    const id = "session_ca9b5a60-f6da-47f8-b2fa-84805e8c8161";
    expect(
      buildAgentArgs("kimi", { model: "kimi-k2", sessionId: id }).args
    ).toEqual(["-m", "kimi-k2", "--session", id]);
    expect(
      getProvider("kimi").buildFlags({ model: "kimi-k2", sessionId: id })
    ).toEqual([`--session ${id}`, "-m kimi-k2"]);
  });

  it("is a valid agent type and appears in the New Session picker", () => {
    expect(isValidProviderId("kimi")).toBe(true);
    expect(isValidAgentType("kimi")).toBe(true);
    expect(AGENT_OPTIONS.some((o) => o.value === "kimi")).toBe(true);
  });
});

// Guards against half-wiring a provider (registry entry without a provider
// object, a picker option for a non-existent id, etc.).
describe("provider registry integrity", () => {
  it("every registry id has a matching provider object and definition", () => {
    for (const id of PROVIDER_IDS) {
      expect(getProvider(id).id).toBe(id);
      expect(getProviderDefinition(id).id).toBe(id);
    }
    expect(getAllProviders()).toHaveLength(PROVIDER_IDS.length);
    expect(getAllProviderDefinitions()).toHaveLength(PROVIDER_IDS.length);
  });

  it("every agent-picker option maps to a real provider id", () => {
    for (const opt of AGENT_OPTIONS) {
      expect(isValidProviderId(opt.value)).toBe(true);
    }
  });

  it("buildAgentArgs uses each provider's cli as the spawn binary", () => {
    for (const id of PROVIDER_IDS) {
      expect(buildAgentArgs(id, {}).binary).toBe(getProviderDefinition(id).cli);
    }
  });
});

// Locks the per-provider readiness contract that spawnWorker's wait loop
// consumes (lib/orchestration.ts): each provider declares how a freshly-spawned
// worker signals "ready" and any trust prompt to auto-accept. Claude must stay
// byte-identical to the strings the loop used to hardcode.
describe("orchestration readiness contract", () => {
  it("every provider declares readyPatterns + trustPromptPatterns arrays", () => {
    for (const id of PROVIDER_IDS) {
      const p = getProvider(id);
      expect(Array.isArray(p.readyPatterns)).toBe(true);
      expect(Array.isArray(p.trustPromptPatterns)).toBe(true);
    }
  });

  it("Claude's cues match the old hardcoded strings (byte-identical)", () => {
    const p = getProvider("claude");
    expect(p.readyPatterns.some((r) => r.test("  │ ? for shortcuts"))).toBe(
      true
    );
    expect(p.readyPatterns.some((r) => r.test("?>"))).toBe(true);
    expect(
      p.trustPromptPatterns.some((r) => r.test("Ready to code here?"))
    ).toBe(true);
    expect(p.trustPromptPatterns.some((r) => r.test("❯ Yes, continue"))).toBe(
      true
    );
    expect(
      p.trustPromptPatterns.some((r) => r.test("I need permission to work"))
    ).toBe(true);
  });

  it("Hermes is ready on its 'Session:' banner; --yolo means no trust prompt", () => {
    const p = getProvider("hermes");
    expect(
      p.readyPatterns.some((r) => r.test("   Session: 20260531_133925_98d9fc"))
    ).toBe(true);
    // a still-initializing screen must NOT read as ready
    expect(
      p.readyPatterns.some((r) => r.test("Initializing agent…\nLoading tools"))
    ).toBe(false);
    expect(p.trustPromptPatterns).toEqual([]);
  });

  it("Kilo and Kimi have empty ready/trust patterns (fallback to timeout)", () => {
    expect(getProvider("kilo").readyPatterns).toEqual([]);
    expect(getProvider("kilo").trustPromptPatterns).toEqual([]);
    expect(getProvider("kimi").readyPatterns).toEqual([]);
    expect(getProvider("kimi").trustPromptPatterns).toEqual([]);
  });

  // "Enable orchestration" wires the stoa MCP server per provider convention:
  // Claude reads a project .mcp.json; Codex gets per-launch `-c mcp_servers.stoa.*`
  // flags; Hermes gets a global `mcp add` + a cwd marker file. The New Session box
  // and the create route both gate on this flag — only `shell` stays off.
  it("every agent provider advertises supportsOrchestration; shell does not", () => {
    for (const id of PROVIDER_IDS) {
      const expected = id !== "shell";
      expect(Boolean(getProviderDefinition(id).supportsOrchestration)).toBe(
        expected
      );
    }
  });
});

// sessionKey() is the single constructor for the `{provider}-{id}` namespace;
// these lock its format and that it stays the exact inverse of the parsers so
// the migration from 13 hand-built sites is byte-identical.
describe("sessionKey() — centralized session-name construction", () => {
  const UUID = "12345678-1234-1234-1234-123456789abc";

  it("builds the canonical {provider}-{id} for each provider (format lock)", () => {
    expect(sessionKey({ kind: "agent", provider: "claude", id: "abc" })).toBe(
      "claude-abc"
    );
    expect(sessionKey({ kind: "agent", provider: "codex", id: "abc" })).toBe(
      "codex-abc"
    );
    expect(sessionKey({ kind: "agent", provider: "hermes", id: "abc" })).toBe(
      "hermes-abc"
    );
    expect(sessionKey({ kind: "agent", provider: "shell", id: "abc" })).toBe(
      "shell-abc"
    );
  });

  it("shell sugar equals the explicit shell-provider form", () => {
    expect(sessionKey({ kind: "shell", id: UUID })).toBe(
      sessionKey({ kind: "agent", provider: "shell", id: UUID })
    );
    expect(sessionKey({ kind: "shell", id: UUID })).toBe(`shell-${UUID}`);
  });

  it("round-trips through the parsers + managed pattern for every provider", () => {
    for (const id of PROVIDER_IDS) {
      const key = sessionKey({ kind: "agent", provider: id, id: UUID });
      expect(getProviderIdFromSessionName(key)).toBe(id);
      expect(getSessionIdFromName(key)).toBe(UUID);
      expect(getManagedSessionPattern().test(key)).toBe(true);
    }
  });

  it("no provider id prefixes another (keeps getProviderIdFromSessionName unambiguous)", () => {
    for (const a of PROVIDER_IDS) {
      for (const b of PROVIDER_IDS) {
        if (a !== b) expect(`${a}-`.startsWith(`${b}-`)).toBe(false);
      }
    }
  });

  // backendKeyForSession resolves the pty/tmux key DELETE (and status/orchestration)
  // use to address a session's process — tmux_name, else the computed key.
  it("backendKeyForSession prefers tmux_name, falls back to {provider}-{id}", () => {
    expect(backendKeyForSession({ id: "x", tmux_name: "claude-x" })).toBe(
      "claude-x"
    );
    expect(
      backendKeyForSession({ id: "x", tmux_name: null, agent_type: "codex" })
    ).toBe("codex-x");
    expect(backendKeyForSession({ id: "x", tmux_name: "" })).toBe("claude-x");
    expect(backendKeyForSession({ id: "x" })).toBe("claude-x");
    // null/empty/unknown agent_type → claude (never a malformed "-<id>" key).
    expect(backendKeyForSession({ id: "x", agent_type: "" })).toBe("claude-x");
    expect(backendKeyForSession({ id: "x", agent_type: "bogus" })).toBe(
      "claude-x"
    );
  });
});

describe("buildFlags shell-quotes value tokens (tmux command-injection guard)", () => {
  // The tmux backend execs buildFlags' output in a shell, so an unquoted model or
  // session id is command injection — most acutely a FREE-TEXT hermes model from
  // an operator-set project default_model. buildFlags must route those value
  // tokens through shellQuoteArg; the pty/argv path (buildAgentArgs) must NOT
  // quote (it spawns argv directly, no shell). shellQuoteArg's own escaping is
  // locked in build-agent-args.test.ts; here we lock that buildFlags USES it.
  const EVIL = "evil; touch /tmp/pwned";

  it("quotes a metacharacter-bearing free-text (hermes) model", () => {
    expect(getProvider("hermes").buildFlags({ model: EVIL })).toEqual([
      `-m ${shellQuoteArg(EVIL)}`,
    ]);
    // The dangerous form is contained in double quotes, not left bare.
    expect(getProvider("hermes").buildFlags({ model: EVIL })[0]).toBe(
      '-m "evil; touch /tmp/pwned"'
    );
  });

  it("quotes the model for claude + codex too", () => {
    expect(getProvider("claude").buildFlags({ model: EVIL })).toEqual([
      `--model ${shellQuoteArg(EVIL)}`,
    ]);
    expect(getProvider("codex").buildFlags({ model: EVIL })).toEqual([
      `--model ${shellQuoteArg(EVIL)}`,
    ]);
  });

  it("quotes a metacharacter-bearing free-text (kilo + kimi) model", () => {
    // Both take a FREE-TEXT model from an operator-set default — the most acute
    // injection vector. Each must route the value through shellQuoteArg.
    expect(getProvider("kilo").buildFlags({ model: EVIL })).toEqual([
      `--model ${shellQuoteArg(EVIL)}`,
    ]);
    expect(getProvider("kilo").buildFlags({ model: EVIL })[0]).toBe(
      '--model "evil; touch /tmp/pwned"'
    );
    expect(getProvider("kimi").buildFlags({ model: EVIL })).toEqual([
      `-m ${shellQuoteArg(EVIL)}`,
    ]);
    expect(getProvider("kimi").buildFlags({ model: EVIL })[0]).toBe(
      '-m "evil; touch /tmp/pwned"'
    );
  });

  it("does NOT quote kilo/kimi on the pty/argv path — buildAgentArgs passes raw tokens", () => {
    expect(buildAgentArgs("kilo", { model: EVIL }).args).toEqual([
      "--model",
      EVIL,
    ]);
    expect(buildAgentArgs("kimi", { model: EVIL }).args).toEqual(["-m", EVIL]);
  });

  it("quotes a metacharacter-bearing session id on the tmux resume path", () => {
    expect(getProvider("hermes").buildFlags({ sessionId: EVIL })).toEqual([
      `--resume ${shellQuoteArg(EVIL)}`,
    ]);
  });

  it("quotes the session id on claude's resume AND fork (parentSessionId) branches", () => {
    // claude_session_id / parent_session_id are writable DB columns, so both
    // resume branches must quote — each is a distinct code path.
    expect(getProvider("claude").buildFlags({ sessionId: EVIL })).toEqual([
      `--resume ${shellQuoteArg(EVIL)}`,
    ]);
    expect(getProvider("claude").buildFlags({ parentSessionId: EVIL })).toEqual(
      [`--resume ${shellQuoteArg(EVIL)}`, "--fork-session"]
    );
  });

  it("leaves a normal model / session id byte-identical (safe tokens pass through)", () => {
    expect(getProvider("claude").buildFlags({ model: "opus" })).toEqual([
      "--model opus",
    ]);
    expect(
      getProvider("hermes").buildFlags({ sessionId: "20260531_133925_98d9fc" })
    ).toEqual(["--resume 20260531_133925_98d9fc"]);
  });

  it("does NOT quote on the pty/argv path — buildAgentArgs passes raw tokens", () => {
    expect(buildAgentArgs("hermes", { model: EVIL }).args).toEqual([
      "-m",
      EVIL,
    ]);
  });
});
