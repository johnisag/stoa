/**
 * First-run onboarding readiness (#30) — the PURE decision core.
 *
 * Client-safe on purpose (no node builtins, no lib/platform): the
 * OnboardingChecklist imports these to turn the GET /api/readiness payload plus
 * facts the shell already knows (projects/sessions from props, the page
 * hostname) into step done/todo states. The server-side probes (resolveBinary
 * on PATH, auth evidence on disk) live in lib/readiness-server.ts — mirroring
 * the lib/rate-limit-window.ts (client) vs -source.ts (server) split.
 */

/** Agent CLIs the readiness probe looks for — the provider registry minus
 *  "shell" (kept as a literal list so this module stays dependency-free; the
 *  same set `stoa doctor` checks). */
export const READINESS_AGENTS = [
  "claude",
  "codex",
  "hermes",
  "kilo",
  "kimi",
] as const;
export type ReadinessAgent = (typeof READINESS_AGENTS)[number];

/** GET /api/readiness response shape. */
export interface ReadinessPayload {
  /** Which agent CLIs resolve on PATH. */
  agents: Record<ReadinessAgent, boolean>;
  /** GitHub CLI on PATH (powers Dispatch / PR features — advisory only). */
  gh: boolean;
  /** Best-effort evidence some agent CLI has been run + signed in. */
  authHint: boolean;
}

/** All-false payload — the render fallback while loading / on a failed fetch. */
export const EMPTY_READINESS: ReadinessPayload = Object.freeze({
  agents: Object.freeze({
    claude: false,
    codex: false,
    hermes: false,
    kilo: false,
    kimi: false,
  }),
  gh: false,
  authHint: false,
});

/** The agent CLIs present in a payload, in registry order. */
export function foundAgents(
  agents: Record<ReadinessAgent, boolean>
): ReadinessAgent[] {
  return READINESS_AGENTS.filter((a) => agents[a]);
}

export type OnboardingStepId =
  | "agent-cli"
  | "agent-auth"
  | "working-dir"
  | "remote-access"
  | "first-session";

export interface OnboardingStep {
  id: OnboardingStepId;
  label: string;
  done: boolean;
  /** A completion detail when done, an actionable hint when not. */
  detail: string;
  /** Advisory only — excluded from the progress fraction. */
  optional?: boolean;
}

/** Everything the step matrix depends on: the server payload + client facts. */
export interface OnboardingInputs {
  readiness: ReadinessPayload;
  hasProjects: boolean;
  hasSessions: boolean;
  /** True when the page is being viewed from another device (non-loopback). */
  isRemoteClient: boolean;
}

/**
 * The 3–5 step first-run checklist, in order. Pure — unit-tested as a matrix
 * in test/readiness.test.ts. Auth (step 2) requires an agent to be FOUND too:
 * a stale ~/.claude.json without the CLI on PATH must not read as signed-in.
 */
export function computeOnboardingSteps(i: OnboardingInputs): OnboardingStep[] {
  const found = foundAgents(i.readiness.agents);
  const hasAgent = found.length > 0;
  return [
    {
      id: "agent-cli",
      label: "Install an agent CLI",
      done: hasAgent,
      detail: hasAgent
        ? `Found: ${found.join(", ")}` +
          (i.readiness.gh
            ? ""
            : ". Tip: install the GitHub CLI (gh) to unlock PR features.")
        : "Install at least one: Claude Code, Codex, Hermes, Kilo, or Kimi.",
    },
    {
      id: "agent-auth",
      label: "Sign in to your agent",
      done: hasAgent && i.readiness.authHint,
      detail:
        hasAgent && i.readiness.authHint
          ? "Sign-in evidence found"
          : "Run the agent once in a terminal (e.g. `claude`) and complete its login.",
    },
    {
      id: "working-dir",
      label: "Pick a working directory",
      done: i.hasProjects,
      detail: i.hasProjects
        ? "Project ready"
        : "Create a project in the New Session dialog — that's where you pick the folder your agent works in.",
    },
    {
      id: "remote-access",
      label: "Open Stoa from your phone",
      done: i.isRemoteClient,
      optional: true,
      detail: i.isRemoteClient
        ? "You're connected from another device"
        : "Optional: visit this machine's LAN address (same port) from your phone — see the README for secure remote access.",
    },
    {
      id: "first-session",
      label: "Create your first session",
      done: i.hasSessions,
      detail: i.hasSessions
        ? "Session created"
        : "New Session → pick an agent and folder, then Create.",
    },
  ];
}

/** Progress over the REQUIRED steps only (optional ones are advisory). */
export function onboardingProgress(steps: OnboardingStep[]): {
  done: number;
  total: number;
} {
  const required = steps.filter((s) => !s.optional);
  return {
    done: required.filter((s) => s.done).length,
    total: required.length,
  };
}

/** True when `hostname` is NOT this machine's loopback — i.e. the page is being
 *  viewed from another device. Pure string check (works on the raw
 *  window.location.hostname, where IPv6 appears bracketed). */
export function isRemoteHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (!h) return false;
  return h !== "localhost" && h !== "127.0.0.1" && h !== "::1" && h !== "[::1]";
}

/** localStorage key for the checklist's "don't show again" flag. */
export const ONBOARDING_DISMISSED_KEY = "stoa-onboarding-dismissed";

/**
 * Show the checklist only on the TRUE empty state (no sessions yet) and only
 * until the user dismisses it. `dismissedFlag` is the raw localStorage value
 * (null when never dismissed) so the decision stays pure and testable.
 */
export function shouldShowOnboarding(
  sessionCount: number,
  dismissedFlag: string | null
): boolean {
  return sessionCount === 0 && dismissedFlag !== "1";
}
