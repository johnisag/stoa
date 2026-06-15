/**
 * Agent Provider Abstraction
 *
 * Defines interfaces and implementations for different AI coding CLI tools
 * (Claude Code, Codex, Hermes).
 *
 * Uses centralized provider registry from lib/providers/registry.ts
 */

import {
  type ProviderId,
  type ProviderDefinition,
  getProviderDefinition,
  getAllProviderDefinitions,
  isValidProviderId,
} from "./providers/registry";

export type AgentType = ProviderId;

export interface AgentProvider {
  // Metadata
  id: AgentType;
  name: string;
  description: string;
  command: string;

  // Session management
  supportsResume: boolean;
  supportsFork: boolean;

  // Build the CLI command flags
  buildFlags(options: BuildFlagsOptions): string[];

  // Status detection patterns
  waitingPatterns: RegExp[];
  runningPatterns: RegExp[];
  idlePatterns: RegExp[];

  // Orchestration readiness (consulted by spawnWorker's wait loop): how a
  // freshly spawned worker signals it's ready for its first prompt, and any
  // trust/permission prompt to auto-accept while waiting (workers auto-approve,
  // so trust handling is mostly defensive). An empty/unmatched readyPatterns
  // falls back to sending after the timeout, so an unknown agent still runs.
  readyPatterns: RegExp[];
  trustPromptPatterns: RegExp[];

  // Session ID detection (optional - not all CLIs support this)
  getSessionId?: (projectPath: string) => string | null;

  // Config directory
  configDir: string;
}

export interface BuildFlagsOptions {
  sessionId?: string | null; // For resume
  parentSessionId?: string | null; // For fork
  skipPermissions?: boolean;
  autoApprove?: boolean; // Use auto-approve flag from registry
  model?: string;
  initialPrompt?: string; // Initial prompt to send to agent
  // Extra launch tokens appended before the positional prompt — used to wire a
  // conductor's MCP server (e.g. Codex's `-c mcp_servers.stoa.*`). Clean argv
  // tokens; buildAgentArgs passes them through, the tmux caller shell-quotes.
  extraArgs?: string[];
}

// Common spinner characters used across CLIs
const SPINNER_CHARS = /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/;

/**
 * Whether to pass `modelFlag <model>` for this spawn. The model drives a FRESH
 * launch, but on resume/fork we skip it for providers that restore the session's
 * own model (Claude) — re-asserting would override it, e.g. an older session row
 * that stored the previously-inert default. Shared by both spawn paths
 * (buildAgentArgs / pty and the per-provider buildFlags / tmux) so they agree.
 */
function shouldPassModel(
  def: ProviderDefinition,
  options: BuildFlagsOptions
): boolean {
  if (!options.model || !def.modelFlag) return false;
  const resuming = Boolean(options.sessionId || options.parentSessionId);
  return !(resuming && def.restoresModelOnResume);
}

/**
 * Claude Code Provider
 * Anthropic's official CLI for Claude
 */
export const claudeProvider: AgentProvider = {
  id: "claude",
  name: "Claude Code",
  description: "Anthropic's official CLI",
  command: "claude",
  configDir: "~/.claude",

  supportsResume: true,
  supportsFork: true,

  buildFlags(options: BuildFlagsOptions): string[] {
    const def = getProviderDefinition("claude");
    const flags: string[] = [];

    // Auto-approve flag from registry
    if (
      (options.skipPermissions || options.autoApprove) &&
      def.autoApproveFlag
    ) {
      flags.push(def.autoApproveFlag);
    }

    // Model — the picker drives a fresh launch; omitted on resume (Claude keeps
    // the session's own model). Mirrors buildAgentArgs / the pty path. The value
    // is shell-quoted (tmux execs this in a shell): safe tokens pass through
    // unchanged, a metacharacter-bearing one is quoted so it can't break out.
    if (shouldPassModel(def, options)) {
      flags.push(`${def.modelFlag} ${shellQuoteArg(options.model!)}`);
    }

    // Resume/fork (session ids are shell-quoted too — same reason as the model).
    if (options.sessionId && def.resumeFlag) {
      flags.push(`${def.resumeFlag} ${shellQuoteArg(options.sessionId)}`);
    } else if (options.parentSessionId && def.resumeFlag) {
      flags.push(`${def.resumeFlag} ${shellQuoteArg(options.parentSessionId)}`);
      flags.push("--fork-session");
    }

    // Initial prompt (positional argument for Claude)
    if (options.initialPrompt?.trim() && def.initialPromptFlag !== undefined) {
      const prompt = options.initialPrompt.trim();
      // Shell-escape the prompt
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      flags.push(`'${escapedPrompt}'`);
    }

    return flags;
  },

  waitingPatterns: [
    /\[Y\/n\]/i,
    /\[y\/N\]/i,
    /Allow\?/i,
    /Approve\?/i,
    /Continue\?/i,
    /Press Enter/i,
    /waiting for/i,
    /\(yes\/no\)/i,
    /Do you want to/i,
    /Esc to cancel/i,
    />\s*1\.\s*Yes/, // Claude's approval menu
    /Yes, allow all/i,
    /allow all edits/i,
    /allow all commands/i,
  ],

  runningPatterns: [
    /thinking/i,
    /Working/i,
    /Reading/i,
    /Writing/i,
    /Searching/i,
    /Running/i,
    /Executing/i,
    SPINNER_CHARS,
  ],

  idlePatterns: [
    /^>\s*$/m,
    /claude.*>\s*$/im,
    /✻\s*Sautéed/i, // Claude finished processing
    /✻\s*Done/i,
  ],

  // Unchanged from the original hardcoded orchestration strings: ready on the
  // "? for shortcuts" / "?>" prompt; auto-accept the "Ready to code here?" /
  // "Yes, continue" trust menu.
  readyPatterns: [/\? for shortcuts/i, /\?>/],
  trustPromptPatterns: [
    /ready to code here/i,
    /yes, continue/i,
    /need permission to work/i,
  ],
};

/**
 * Codex Provider
 * OpenAI's CLI for code generation
 */
export const codexProvider: AgentProvider = {
  id: "codex",
  name: "Codex",
  description: "OpenAI's CLI",
  command: "codex",
  configDir: "~/.codex",

  supportsResume: false, // Codex doesn't have explicit resume
  supportsFork: false,

  buildFlags(options: BuildFlagsOptions): string[] {
    const def = getProviderDefinition("codex");
    const flags: string[] = [];

    // Auto-approve flag from registry
    if (
      (options.skipPermissions || options.autoApprove) &&
      def.autoApproveFlag
    ) {
      flags.push(def.autoApproveFlag);
    }

    if (shouldPassModel(def, options)) {
      // Shell-quoted — tmux execs this in a shell (safe tokens pass through).
      flags.push(`${def.modelFlag} ${shellQuoteArg(options.model!)}`);
    }

    // Initial prompt (positional argument for Codex)
    if (options.initialPrompt?.trim() && def.initialPromptFlag !== undefined) {
      const prompt = options.initialPrompt.trim();
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      flags.push(`'${escapedPrompt}'`);
    }

    return flags;
  },

  waitingPatterns: [
    /\[Y\/n\]/i,
    /\[y\/N\]/i,
    /approve/i,
    /confirm/i,
    /Press Enter/i,
    /\(yes\/no\)/i,
  ],

  runningPatterns: [/thinking/i, /processing/i, /generating/i, SPINNER_CHARS],

  idlePatterns: [/^>\s*$/m, /codex.*>\s*$/im, /\$\s*$/m],

  // Codex auto-bypasses approvals (no trust prompt). Its interactive-TUI ready
  // cue is TODO from a live `codex` spawn; until filled, the wait loop falls
  // back to sending the task after the timeout (works, just not instant).
  readyPatterns: [],
  trustPromptPatterns: [],
};

/**
 * Hermes Agent (Nous Research) — a Claude-Code-style TUI agent that runs
 * natively on Windows/macOS/Linux and self-authenticates. Spawned via the pty
 * backend exactly like any other CLI agent; rendering is handled by the terminal
 * with no special casing. Minimal flag surface for now (launches the TUI);
 * buildFlags honors any registry flags added later.
 */
export const hermesProvider: AgentProvider = {
  id: "hermes",
  name: "Hermes Agent",
  description: "Nous Research agent harness",
  command: "hermes",
  configDir: "~/.hermes",

  supportsResume: true,
  supportsFork: false,

  buildFlags(options: BuildFlagsOptions): string[] {
    const def = getProviderDefinition("hermes");
    const flags: string[] = [];
    if (
      (options.skipPermissions || options.autoApprove) &&
      def.autoApproveFlag
    ) {
      flags.push(def.autoApproveFlag);
    }
    // Resume from the banner-captured session id (the status route persists it
    // into claude_session_id). This is what brings the conversation back after
    // a restart on the TMUX backend — the pty path (buildAgentArgs) already
    // wires it. Hermes has no fork, so no fork branch.
    if (options.sessionId && def.resumeFlag) {
      flags.push(`${def.resumeFlag} ${shellQuoteArg(options.sessionId)}`);
    }
    if (shouldPassModel(def, options)) {
      // Shell-quoted — Hermes models are FREE-TEXT, so an unquoted value would be
      // shell injection into the tmux launch on the POSIX backend. shellQuoteArg
      // leaves a normal model untouched and quotes anything with metacharacters.
      flags.push(`${def.modelFlag} ${shellQuoteArg(options.model!)}`);
    }
    if (options.initialPrompt?.trim() && def.initialPromptFlag !== undefined) {
      const prompt = options.initialPrompt.trim().replace(/'/g, "'\\''");
      flags.push(
        def.initialPromptFlag === ""
          ? `'${prompt}'`
          : `${def.initialPromptFlag} '${prompt}'`
      );
    }
    return flags;
  },

  // Shared TUI conventions; tune once we observe Hermes busy/waiting output.
  waitingPatterns: [
    /\[Y\/n\]/i,
    /\[y\/N\]/i,
    /Allow\?/i,
    /Approve\?/i,
    /Continue\?/i,
    /Press Enter/i,
    /Do you want to/i,
  ],
  runningPatterns: [SPINNER_CHARS, /esc to interrupt/i, /tokens/i],
  idlePatterns: [],

  // Ready on the startup "Session: <YYYYMMDD_HHMMSS_hex>" banner (the same cue
  // the status detector captures); --yolo means no trust prompt to accept.
  readyPatterns: [/Session:\s*\d{8}_\d{6}/],
  trustPromptPatterns: [],
};

/**
 * Kilo Code (open-source agentic CLI; @kilocode/cli, an OpenCode fork) — a
 * Claude-Code-style TUI agent that self-authenticates and runs natively on
 * Windows/macOS/Linux. Spawned via the pty/tmux backends like any other CLI.
 * Free-text "provider/model" models (no static catalog); see the registry note.
 * Mirrors the Hermes shape: resume re-asserts the (free-text) model and the
 * model token is shell-quoted on the tmux path. No auto-approve on the bare TUI
 * (that flag lives on `kilo run`), and no positional prompt (the positional is a
 * directory) — so neither branch fires here.
 */
export const kiloProvider: AgentProvider = {
  id: "kilo",
  name: "Kilo Code",
  description: "open-source agentic CLI",
  command: "kilo",
  configDir: "~/.config/kilo",

  // Fresh-launch-only for now (lockstep with the registry def): kilo has
  // --session/--fork, but Stoa doesn't yet capture its TUI session id.
  supportsResume: false,
  supportsFork: false,

  buildFlags(options: BuildFlagsOptions): string[] {
    const def = getProviderDefinition("kilo");
    const flags: string[] = [];
    if (
      (options.skipPermissions || options.autoApprove) &&
      def.autoApproveFlag
    ) {
      flags.push(def.autoApproveFlag);
    }
    if (options.sessionId && def.resumeFlag) {
      flags.push(`${def.resumeFlag} ${shellQuoteArg(options.sessionId)}`);
    }
    if (shouldPassModel(def, options)) {
      // Shell-quoted — Kilo models are FREE-TEXT, so an unquoted value would be
      // shell injection into the tmux launch on the POSIX backend.
      flags.push(`${def.modelFlag} ${shellQuoteArg(options.model!)}`);
    }
    if (options.initialPrompt?.trim() && def.initialPromptFlag !== undefined) {
      const prompt = options.initialPrompt.trim().replace(/'/g, "'\\''");
      flags.push(
        def.initialPromptFlag === ""
          ? `'${prompt}'`
          : `${def.initialPromptFlag} '${prompt}'`
      );
    }
    return flags;
  },

  // Shared TUI conventions; tune once we observe Kilo busy/waiting output.
  waitingPatterns: [
    /\[Y\/n\]/i,
    /\[y\/N\]/i,
    /Allow\?/i,
    /Approve\?/i,
    /Continue\?/i,
    /Press Enter/i,
    /Do you want to/i,
  ],
  runningPatterns: [SPINNER_CHARS, /esc to interrupt/i, /tokens/i],
  idlePatterns: [],

  // Ready/trust cues are TODO from a live `kilo` spawn; until filled, the wait
  // loop falls back to sending after the timeout (works, just not instant).
  readyPatterns: [],
  trustPromptPatterns: [],
};

/**
 * Kimi Code (Moonshot AI) — a terminal coding agent used exactly like Claude
 * Code. Binary `kimi` (at ~/.kimi-code/bin), self-authenticates via `kimi login`
 * (config under ~/.kimi-code), and runs natively on all three OSes. Spawned via
 * the pty/tmux backends like any other CLI. Free-text/config-defined model (no
 * static catalog; the default comes from config.toml). Mirrors the Hermes shape:
 * --yolo auto-approve, resume re-asserts the (free-text) model, and the model
 * token is shell-quoted on the tmux path.
 */
export const kimiProvider: AgentProvider = {
  id: "kimi",
  name: "Kimi Code",
  description: "Moonshot AI's coding agent",
  command: "kimi",
  configDir: "~/.kimi-code",

  // Resume ON (lockstep with the registry def): Stoa captures kimi's id from
  // ~/.kimi-code/session_index.jsonl and passes `--session <id>` on respawn.
  supportsResume: true,
  supportsFork: false,

  buildFlags(options: BuildFlagsOptions): string[] {
    const def = getProviderDefinition("kimi");
    const flags: string[] = [];
    if (
      (options.skipPermissions || options.autoApprove) &&
      def.autoApproveFlag
    ) {
      flags.push(def.autoApproveFlag);
    }
    if (options.sessionId && def.resumeFlag) {
      flags.push(`${def.resumeFlag} ${shellQuoteArg(options.sessionId)}`);
    }
    if (shouldPassModel(def, options)) {
      // Shell-quoted — Kimi models are FREE-TEXT, so an unquoted value would be
      // shell injection into the tmux launch on the POSIX backend.
      flags.push(`${def.modelFlag} ${shellQuoteArg(options.model!)}`);
    }
    if (options.initialPrompt?.trim() && def.initialPromptFlag !== undefined) {
      const prompt = options.initialPrompt.trim().replace(/'/g, "'\\''");
      flags.push(
        def.initialPromptFlag === ""
          ? `'${prompt}'`
          : `${def.initialPromptFlag} '${prompt}'`
      );
    }
    return flags;
  },

  // Shared TUI conventions; tune once we observe Kimi busy/waiting output.
  waitingPatterns: [
    /\[Y\/n\]/i,
    /\[y\/N\]/i,
    /Allow\?/i,
    /Approve\?/i,
    /Continue\?/i,
    /Press Enter/i,
    /Do you want to/i,
  ],
  runningPatterns: [SPINNER_CHARS, /esc to interrupt/i, /tokens/i],
  idlePatterns: [],

  // Ready/trust cues are TODO from a live `kimi` spawn; --yolo means no trust
  // prompt to accept. Falls back to sending after the timeout until filled.
  readyPatterns: [],
  trustPromptPatterns: [],
};

/**
 * Shell Provider
 * Plain terminal without any AI CLI
 */
export const shellProvider: AgentProvider = {
  id: "shell",
  name: "Terminal",
  description: "Plain shell terminal",
  command: "", // No command - just shell
  configDir: "",

  supportsResume: false,
  supportsFork: false,

  buildFlags(): string[] {
    return []; // No flags for shell
  },

  waitingPatterns: [],
  runningPatterns: [],
  idlePatterns: [/\$\s*$/m, />\s*$/m, /%\s*$/m],
  readyPatterns: [],
  trustPromptPatterns: [],
};

// Provider registry
export const providers: Record<AgentType, AgentProvider> = {
  claude: claudeProvider,
  codex: codexProvider,
  hermes: hermesProvider,
  kilo: kiloProvider,
  kimi: kimiProvider,
  shell: shellProvider,
};

// Get provider by ID
export function getProvider(agentType: AgentType): AgentProvider {
  return providers[agentType] || claudeProvider;
}

// Get all providers as array
export function getAllProviders(): AgentProvider[] {
  return Object.values(providers);
}

export interface AgentSpawn {
  /** Executable name (e.g. "claude"); resolved on PATH by the pty registry. */
  binary: string;
  /** Clean argv — no shell quoting, no combined tokens. */
  args: string[];
}

/**
 * Build a clean argv for spawning an agent CLI directly via a pty.
 *
 * This is the argv-array counterpart of provider.buildFlags() (which returns a
 * shell-joined, quoted string for the tmux backend). Tokens that buildFlags
 * combines into one string (e.g. "--resume <id>") and the shell-quoted initial
 * prompt are emitted as discrete argv entries with NO quoting, which is correct
 * for a direct (shell-less) spawn. Used by the native pty path.
 */
export function buildAgentArgs(
  agentType: AgentType,
  options: BuildFlagsOptions
): AgentSpawn {
  const def = getProviderDefinition(agentType);
  const args: string[] = [];

  if (def.defaultArgs) args.push(...def.defaultArgs);

  if ((options.skipPermissions || options.autoApprove) && def.autoApproveFlag) {
    args.push(def.autoApproveFlag);
  }
  if (shouldPassModel(def, options)) {
    args.push(def.modelFlag!, options.model!);
  }
  if (options.sessionId && def.resumeFlag) {
    args.push(def.resumeFlag, options.sessionId);
  } else if (options.parentSessionId && def.resumeFlag) {
    args.push(def.resumeFlag, options.parentSessionId);
    if (def.supportsFork) args.push("--fork-session");
  }
  // Conductor MCP wiring (clean tokens), before the positional prompt.
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  if (options.initialPrompt?.trim() && def.initialPromptFlag !== undefined) {
    const prompt = options.initialPrompt.trim();
    if (def.initialPromptFlag === "") {
      args.push(prompt); // positional, raw
    } else {
      args.push(def.initialPromptFlag, prompt);
    }
  }

  return { binary: def.cli, args };
}

/**
 * Parse a session's persisted `mcp_launch_args` (a JSON string-array, e.g. Codex's
 * conductor `-c mcp_servers.stoa.*` wiring) into clean argv tokens for `extraArgs`.
 * Defensive: a null/absent/malformed/non-array value yields [] so a spawn proceeds
 * WITHOUT the conductor flags rather than failing. The SINGLE parser — every spawn
 * site (the server path in app/page.tsx AND buildSpawnForSession's pty re-attach)
 * must go through this so they can't drift (the bug that lost a Codex conductor's
 * MCP wiring on re-attach was exactly that drift).
 */
export function parseMcpLaunchArgs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    // Malformed — degrade to a spawn without the conductor flags rather than
    // failing the whole launch. Warn so a Codex conductor that silently comes up
    // without its stoa MCP server is at least diagnosable from the logs.
    console.warn(
      "[parseMcpLaunchArgs] ignoring malformed mcp_launch_args:",
      raw
    );
    return [];
  }
}

/**
 * Backslash-escape the chars that stay active inside a double-quoted POSIX shell
 * string (`\ " $ \``). The SINGLE source for double-quote escaping — used by
 * shellQuoteArg below AND by the tmux init-script fallback in app/page.tsx, where
 * a raw command is interpolated into the tmux backend's outer `"${command}"` and
 * needs the same containment. (Bash history `!` is intentionally NOT escaped: in
 * double quotes `\!` keeps the backslash, so escaping it would corrupt benign
 * prompts; non-interactive shells don't history-expand.)
 */
export function escapeForDoubleQuotes(token: string): string {
  return token.replace(/(["\\$`])/g, "\\$1");
}

/**
 * Shell-quote a single clean argv token for the tmux backend's `exec <cmd>`
 * line (the pty backend spawns argv directly and needs no quoting). Bare
 * word-safe tokens pass through; anything else is wrapped in double quotes with
 * `\ " $ \`` escaped — enough for the conductor `-c mcp_servers.stoa.*` tokens
 * (which contain TOML single-quotes, brackets, commas, and `=`).
 */
export function shellQuoteArg(token: string): string {
  if (/^[A-Za-z0-9_./=:-]+$/.test(token)) return token;
  return `"${escapeForDoubleQuotes(token)}"`;
}

/**
 * Assemble the tmux backend's flag list: the provider's buildFlags() output plus
 * the conductor's (already shell-quoted) extraArgs, with extraArgs placed BEFORE
 * a trailing positional prompt. buildFlags appends the positional prompt LAST
 * (Codex), so a naive concat puts the `-c mcp_servers.stoa.*` wiring AFTER the
 * prompt — the opposite of the pty path (buildAgentArgs inserts extraArgs before
 * the prompt, locked by test), and Codex may then ignore the trailing flags.
 * Only Codex conductors have extraArgs today; the splice keeps both paths
 * ordering-identical.
 */
export function buildTmuxFlags(
  baseFlags: string[],
  quotedExtraArgs: string[],
  hasTrailingPrompt: boolean
): string[] {
  if (!quotedExtraArgs.length) return baseFlags;
  if (hasTrailingPrompt && baseFlags.length) {
    return [
      ...baseFlags.slice(0, -1),
      ...quotedExtraArgs,
      baseFlags[baseFlags.length - 1],
    ];
  }
  return [...baseFlags, ...quotedExtraArgs];
}

// Type guard (use registry)
export function isValidAgentType(value: string): value is AgentType {
  return isValidProviderId(value);
}

// Export registry functions for convenience
export {
  getProviderDefinition,
  getAllProviderDefinitions,
} from "./providers/registry";
