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
}

// Common spinner characters used across CLIs
const SPINNER_CHARS = /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/;

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

    // Resume/fork
    if (options.sessionId && def.resumeFlag) {
      flags.push(`${def.resumeFlag} ${options.sessionId}`);
    } else if (options.parentSessionId && def.resumeFlag) {
      flags.push(`${def.resumeFlag} ${options.parentSessionId}`);
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

    if (options.model && def.modelFlag) {
      flags.push(`${def.modelFlag} ${options.model}`);
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
      flags.push(`${def.resumeFlag} ${options.sessionId}`);
    }
    if (options.model && def.modelFlag) {
      flags.push(`${def.modelFlag} ${options.model}`);
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
  if (options.model && def.modelFlag) {
    args.push(def.modelFlag, options.model);
  }
  if (options.sessionId && def.resumeFlag) {
    args.push(def.resumeFlag, options.sessionId);
  } else if (options.parentSessionId && def.resumeFlag) {
    args.push(def.resumeFlag, options.parentSessionId);
    if (def.supportsFork) args.push("--fork-session");
  }
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

// Type guard (use registry)
export function isValidAgentType(value: string): value is AgentType {
  return isValidProviderId(value);
}

// Export registry functions for convenience
export {
  getProviderDefinition,
  getAllProviderDefinitions,
} from "./providers/registry";
