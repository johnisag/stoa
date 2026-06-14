/**
 * Provider Registry
 *
 * Centralized configuration for all AI coding agent providers.
 */

export const PROVIDER_IDS = [
  "claude",
  "codex",
  "hermes",
  "kilo",
  "kimi",
  "shell",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Provider Definition
 * Declarative configuration for each agent provider
 */
export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  description: string;

  // CLI configuration
  cli: string; // Command name (e.g., 'claude', 'codex')
  configDir: string; // Config directory path

  // Auto-approve configuration
  autoApproveFlag?: string; // Flag to skip permission prompts

  // Orchestration (conductor): can this provider pick up the stoa MCP server
  // that "Enable orchestration" writes? Today that wiring is a `.mcp.json`,
  // which is Claude Code's convention only — Codex (`~/.codex/config.toml`) and
  // Hermes (`hermes mcp add`) use their own stores, so the box must not pretend
  // to work for them. Flip this on per provider once its convention is wired.
  supportsOrchestration?: boolean;

  // Session management
  supportsResume: boolean;
  supportsFork: boolean;
  resumeFlag?: string; // Flag for resuming sessions

  // Model configuration
  modelFlag?: string; // Flag for specifying model

  // True when the CLI restores a resumed session's own model on `--resume`
  // (Claude does). For such a provider we DON'T re-pass `modelFlag` when
  // resuming/forking — forcing it would override the session's real model
  // (notably an older row that stored the previously-inert default).
  restoresModelOnResume?: boolean;

  // Initial prompt configuration
  // undefined = no support, '' = positional arg, string = flag (e.g., '--prompt')
  initialPromptFlag?: string;

  // Default arguments
  defaultArgs?: string[]; // Always passed to CLI
}

/**
 * Provider Registry
 * All supported agent providers with their configurations
 */
export const PROVIDERS: ProviderDefinition[] = [
  {
    id: "claude",
    name: "Claude Code",
    description: "Anthropic's official CLI",
    cli: "claude",
    configDir: "~/.claude",
    autoApproveFlag: "--dangerously-skip-permissions",
    supportsResume: true,
    supportsFork: true,
    resumeFlag: "--resume",
    // Claude Code DOES take --model (an alias for the latest of a family —
    // 'opus'/'sonnet'/'haiku' — or a full id like 'claude-opus-4-8'), so the
    // model picker actually drives the launch model. Verified via `claude --help`.
    // On `--resume` Claude restores the session's own model, so we omit --model
    // then (see restoresModelOnResume) rather than override it.
    modelFlag: "--model",
    restoresModelOnResume: true,
    initialPromptFlag: "", // Positional argument
    supportsOrchestration: true, // reads project .mcp.json on launch
  },
  {
    id: "codex",
    name: "Codex",
    description: "OpenAI's CLI",
    cli: "codex",
    configDir: "~/.codex",
    autoApproveFlag: "--dangerously-bypass-approvals-and-sandbox",
    supportsResume: false,
    supportsFork: false,
    modelFlag: "--model",
    initialPromptFlag: "", // Positional argument
    // Wired via per-launch `-c mcp_servers.stoa.*` flags (buildCodexOrchestrationArgs),
    // replayed from the session's mcp_launch_args — no global config pollution.
    supportsOrchestration: true,
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    description: "Nous Research agent harness",
    cli: "hermes",
    configDir: "~/.hermes",
    // Launches the interactive Hermes TUI (self-authenticating, like Claude Code).
    // CLI surface (from `hermes --help`): -z PROMPT, -m MODEL, --resume SESSION,
    // --continue, --yolo, --pass-session-id.
    //  - --yolo wired here (auto-approve).
    //  - resume is ON: Stoa captures Hermes's session id from the startup banner
    //    ("Session: <YYYYMMDD_HHMMSS_hex>") via the status detector's screen
    //    capture and persists it; buildAgentArgs then passes `--resume <id>`.
    //    Best-effort: Hermes only flushes its session JSON on clean exit, so a
    //    hard-killed session may not be resumable (degrades to a fresh session).
    //  - modelFlag is "-m": Hermes models are dynamic/provider-specific
    //    (`hermes model` live-fetches /v1/models), so Stoa offers a FREE-TEXT
    //    model field (no static list) rather than a dropdown. An empty model
    //    leaves Hermes on its own configured default (no -m passed).
    //    restoresModelOnResume is deliberately UNSET: Hermes re-asserts `-m` on
    //    resume (the long-standing behavior) — whether its TUI restores its own
    //    model is unverified, so we don't drop the flag.
    //  - -z initial prompt held until interactive-vs-one-shot is confirmed.
    autoApproveFlag: "--yolo",
    resumeFlag: "--resume",
    modelFlag: "-m",
    supportsResume: true,
    supportsFork: false,
    // Wired via a one-time global `hermes mcp add` + a `.stoa-conductor` marker
    // in the working dir (Hermes strips env vars from MCP children, so the
    // conductor id can't ride the process env). See lib/mcp-config.ts.
    supportsOrchestration: true,
  },
  {
    id: "kilo",
    name: "Kilo Code",
    description: "open-source agentic CLI",
    cli: "kilo",
    configDir: "~/.config/kilo",
    // Launches Kilo's interactive TUI (an OpenCode fork; @kilocode/cli).
    // Self-authenticating: the user signs in once via the TUI (`kilo auth` /
    // /connect), so no env var is required to launch. Verified via
    // `kilo --help` / `kilo run --help` (v7.3.45).
    //  - modelFlag is "--model": models are a free-text "provider/model" string
    //    served DYNAMICALLY via the Kilo gateway (500+), so Stoa offers a
    //    FREE-TEXT model field (no static list). An empty model leaves Kilo on
    //    its own configured default (no --model passed).
    //  - resume/fork are NOT enabled yet: kilo HAS `-s, --session <id>` / `--fork`
    //    and resumeFlag is kept ("--session") so the plumbing is ready, but Stoa
    //    doesn't yet capture kilo's TUI session id, so supportsResume/supportsFork
    //    stay false (fresh-launch-only) until a follow-up wires id-capture.
    //  - NO auto-approve flag for the bare TUI: `--auto` is a `kilo run`
    //    subcommand flag only, so autoApproveFlag stays UNSET here.
    //  - The bare `kilo [project]` positional is a DIRECTORY, not a prompt — Stoa
    //    sets the pty cwd, so no positional is passed (initialPromptFlag unset).
    autoApproveFlag: undefined,
    resumeFlag: "--session",
    modelFlag: "--model",
    supportsResume: false,
    supportsFork: false,
  },
  {
    id: "kimi",
    name: "Kimi Code",
    description: "Moonshot AI's coding agent",
    cli: "kimi",
    configDir: "~/.kimi-code",
    // Kimi Code (Moonshot AI) — a terminal coding agent used exactly like Claude
    // Code. Binary command `kimi` (lives at ~/.kimi-code/bin/kimi.exe). Bare
    // `kimi` launches the interactive TUI. Self-authenticating: `kimi login`
    // (device-code flow) writes credentials under ~/.kimi-code (config.toml,
    // sessions/, credentials/), so no env var is required to launch. Verified via
    // `kimi --help` (v0.14.3).
    //  - modelFlag is "-m": the default model comes from ~/.kimi-code/config.toml
    //    (`default_model = "kimi-code/kimi-for-coding"`, display "K2.7 Code"), so
    //    it's config-defined/free-text (no static catalog) and Stoa offers a
    //    FREE-TEXT model field. An empty model leaves Kimi Code on its own
    //    configured default (no -m passed).
    //  - resume is ON: kimi HAS `-S, --session [id]` (resumeFlag "--session").
    //    Stoa captures the resume id from Kimi Code's startup banner ("Session:
    //    session_<uuid>", like Hermes) with its on-disk session_index.jsonl as a
    //    per-cwd fallback (getProviderSessionId), and passes `--session <id>` on
    //    respawn — the same capture-then-resume pattern as Hermes. No fork.
    //  - auto-approve: `-y, --yolo` ("auto-approve all actions"). --yolo wired
    //    here. (The -p/--prompt headless path is a one-shot, not a persistent
    //    session — not used.)
    //  - No positional prompt on the bare TUI; Stoa sets the pty cwd.
    //    initialPromptFlag unset (user types in the TUI).
    autoApproveFlag: "--yolo",
    resumeFlag: "--session",
    modelFlag: "-m",
    supportsResume: true,
    supportsFork: false,
  },
  {
    id: "shell",
    name: "Terminal",
    description: "Plain shell terminal",
    cli: "", // No CLI command - just shell
    configDir: "",
    autoApproveFlag: undefined,
    supportsResume: false,
    supportsFork: false,
  },
];

/**
 * Provider Map
 * Efficient lookup by provider ID
 */
export const PROVIDER_MAP = new Map<ProviderId, ProviderDefinition>(
  PROVIDERS.map((provider) => [provider.id, provider])
);

/**
 * Get provider definition by ID
 */
export function getProviderDefinition(id: ProviderId): ProviderDefinition {
  const provider = PROVIDER_MAP.get(id);
  if (!provider) {
    throw new Error(`Unknown provider: ${id}`);
  }
  return provider;
}

/**
 * Get all provider definitions
 */
export function getAllProviderDefinitions(): ProviderDefinition[] {
  return PROVIDERS;
}

/**
 * Check if a string is a valid provider ID
 */
export function isValidProviderId(value: string): value is ProviderId {
  return PROVIDER_MAP.has(value as ProviderId);
}

/**
 * Get regex pattern for matching Stoa-managed tmux session names
 * Format: {provider}-{uuid}
 */
export function getManagedSessionPattern(): RegExp {
  const providerPattern = PROVIDER_IDS.join("|");
  return new RegExp(
    `^(${providerPattern})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
    "i"
  );
}

/**
 * Get provider ID from a session name (e.g., "claude-abc123" -> "claude")
 */
export function getProviderIdFromSessionName(
  sessionName: string
): ProviderId | null {
  for (const id of PROVIDER_IDS) {
    if (sessionName.startsWith(`${id}-`)) {
      return id;
    }
  }
  return null;
}

/**
 * Extract the UUID from a session name (e.g., "claude-abc123" -> "abc123")
 */
export function getSessionIdFromName(sessionName: string): string {
  const providerPattern = PROVIDER_IDS.join("|");
  return sessionName.replace(new RegExp(`^(${providerPattern})-`, "i"), "");
}

/**
 * Input to sessionKey(): an agent session (provider + id) or a shell session.
 */
export type SessionKeyInput =
  | { kind: "agent"; provider: ProviderId; id: string }
  | { kind: "shell"; id: string };

/**
 * Build a Stoa-managed session key/name — THE single place the `{provider}-{id}`
 * namespace is constructed (the inverse of getProviderIdFromSessionName /
 * getSessionIdFromName). A shell session uses the "shell" provider prefix.
 * Callers holding a raw agent_type should normalize via getProvider(type).id so
 * the unknown -> "claude" fallback stays single-sourced.
 */
export function sessionKey(input: SessionKeyInput): string {
  const provider = input.kind === "shell" ? "shell" : input.provider;
  return `${provider}-${input.id}`;
}

/**
 * The backend session key for a session row: its stored `tmux_name`, else the
 * canonical `{provider}-{id}`. Single source for "which key addresses this
 * session's pty/tmux" — status detection, orchestration, and delete all need it
 * (and tmux_name can be null for non-tmux sessions).
 */
export function backendKeyForSession(session: {
  id: string;
  tmux_name?: string | null;
  agent_type?: string | null;
}): string {
  if (session.tmux_name) return session.tmux_name;
  // Match getProvider()'s fallback: null/empty/unknown agent_type → claude, so
  // the computed key can never be malformed (e.g. "-<id>") and miss the pty.
  const provider =
    session.agent_type && isValidProviderId(session.agent_type)
      ? session.agent_type
      : "claude";
  return sessionKey({ kind: "agent", provider, id: session.id });
}
