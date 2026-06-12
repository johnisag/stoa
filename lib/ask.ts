/**
 * "Ask Stoa" — the read-only Q&A backend.
 *
 * A user asks a natural-language question about their Stoa fleet; we gather a
 * compact, server-side CONTEXT from Stoa's own data (analytics rollup, the live
 * "needs me" set, the session roster), build a single grounded prompt, and hand
 * it to the user-SELECTED agent CLI in NON-INTERACTIVE mode, capturing the reply.
 *
 * READ-ONLY by construction: we never pass a `--dangerously-*`/bypass flag, never
 * fork or mutate a session, and the prompt instructs the agent to answer from the
 * context without running tools. The spawn shape mirrors the cross-platform-safe
 * one in app/api/sessions/[id]/summarize/route.ts (resolveBinary for the Windows
 * .cmd shim, argv array, content on stdin, sanitizeDigest the reply) plus a hard
 * timeout that KILLS the child so a hung/interactive process can't wedge the
 * request.
 *
 * The route (app/api/ask/route.ts) owns the HTTP surface; this file owns the
 * argv construction (pure), the context gathering (DB + live capture), the prompt
 * text (pure), and the spawn.
 */

import { spawn } from "child_process";
import { resolveBinary, isWindows } from "./platform";
import { sanitizeDigest } from "./summarize";
import { getAnalyticsReport } from "./analytics/queries";
import { computeManagedStatuses } from "./session-status";
import { getDb, queries, type Session } from "./db";
import type { AgentType } from "./providers";

/**
 * The providers Ask Stoa can route a question to. Phase 1 ships claude + codex
 * only: both have a VERIFIED non-interactive mode that takes the prompt on STDIN
 * (so the prompt — which embeds untrusted fleet context — never rides in argv,
 * which would be shell-injectable under the Windows `.cmd` spawn). Hermes is
 * deferred until its `-z` one-shot mode is live-verified AND a stdin/temp-file
 * path replaces argv (the registry flags `-z` as interactive-vs-one-shot
 * unconfirmed; AGENTS.md: only wire a verified flag).
 */
export type AskProvider = "claude" | "codex";

export const ASK_PROVIDERS: readonly AskProvider[] = [
  "claude",
  "codex",
] as const;

/** One prior conversation turn (the optional multi-turn history). */
export interface AskHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** A resolved spawn plan: which binary, its argv, and the prompt to pipe on
 * stdin. The prompt is ALWAYS on stdin (never argv) so untrusted context can't be
 * shell-injected under the Windows `.cmd` spawn (`shell: isWindows`). */
export interface AskSpawn {
  binary: string;
  args: string[];
  input: string;
}

/**
 * Per-provider NON-INTERACTIVE invocation. Flags are VERIFIED from `<cli> --help`:
 *   - claude: `claude -p [--model <m>]`   → prompt on STDIN.
 *   - codex:  `codex exec [-c model=<m>]` → prompt on STDIN (exec reads stdin
 *                             when no prompt arg — "Run Codex non-interactively").
 * `model` is an optional CATALOG value (e.g. "opus" for claude, "gpt-5.4" for
 * codex) — it's a fixed token from getModelOptions, never user free-text, so it's
 * not an injection vector even though it rides in argv. Omitted → the agent's own
 * default. The prompt is ALWAYS on STDIN (never argv) — critical, because
 * `runAsk` spawns with `shell: isWindows` and the prompt embeds untrusted fleet
 * context; argv under a shell would be command-injectable. No `--dangerously-*`/
 * bypass flag is ever added — this is read-only Q&A. The binary is resolved with
 * resolveBinary (so the Windows .cmd shim is found), falling back to the bare
 * name. Pure → unit-tested as the cross-platform argv regression guard.
 */
export function buildAskArgs(
  provider: AskProvider,
  prompt: string,
  model?: string
): AskSpawn {
  switch (provider) {
    case "claude":
      return {
        binary: resolveBinary("claude") || "claude",
        args: model ? ["-p", "--model", model] : ["-p"],
        input: prompt,
      };
    case "codex":
      return {
        binary: resolveBinary("codex") || "codex",
        args: model ? ["exec", "-c", `model=${model}`] : ["exec"],
        input: prompt,
      };
  }
}

/** Inputs to the grounded prompt: the serialized context, the prior turns, and
 * the new question. */
export interface AskPromptInput {
  context: string;
  history?: AskHistoryTurn[];
  question: string;
}

const ASK_PREAMBLE = [
  "You are Stoa's built-in assistant. Answer the user's question about their",
  "Stoa fleet using ONLY the CONTEXT below. Be concise and concrete. If the",
  "context doesn't contain the answer, say so plainly. Do not run commands or",
  "use tools — answer from the context.",
].join(" ");

/**
 * Assemble the single prompt handed to the agent: an instruction preamble, the
 * serialized CONTEXT, the prior history turns (if any), then the user's QUESTION.
 * Pure → unit-tested. The history is rendered as plain "User:/Assistant:" turns
 * (sanitized) so a stray control byte can't ride back into the prompt.
 */
export function buildAskPrompt({
  context,
  history,
  question,
}: AskPromptInput): string {
  const parts: string[] = [ASK_PREAMBLE, "", "=== CONTEXT ===", context];

  if (history && history.length > 0) {
    parts.push("", "=== CONVERSATION SO FAR ===");
    for (const turn of history) {
      const label = turn.role === "assistant" ? "Assistant" : "User";
      parts.push(`${label}: ${sanitizeDigest(turn.content)}`);
    }
  }

  parts.push("", "=== QUESTION ===", sanitizeDigest(question));
  return parts.join("\n");
}

/**
 * Gather a COMPACT, read-only snapshot of the fleet for grounding. Reuses the
 * existing rollups so nothing here is bespoke:
 *   - getAnalyticsReport(windowDays) — already a narrowed, serializable summary
 *     of what the fleet did (sessions, dispatch outcomes, event mix, cost,
 *     detected issues). No raw transcripts.
 *   - computeManagedStatuses() — live per-session {status,lastLine,prompt}; the
 *     "needs me / stuck" set is status==="waiting" && prompt != null. (This does
 *     live screen captures — a bit heavy, but fine for an on-demand call.)
 *   - getAllSessions() — the roster, trimmed to the fields a question is likely
 *     about (name, agent, status, directory).
 * Returns a bounded, readable text block (JSON, so the agent can parse it). We
 * never dump full transcripts — the analytics report is already narrowed.
 */
export async function gatherStoaContext(windowDays = 1): Promise<string> {
  const [report, statuses] = await Promise.all([
    getAnalyticsReport(windowDays).catch(() => null),
    computeManagedStatuses().catch(() => []),
  ]);

  // Roster: trim to the human-meaningful fields (no internal ids/blobs). Also
  // keep an id→name map so the live statuses below read out HUMAN session names,
  // not the managed backend key ("claude-<uuid>") computeManagedStatuses returns.
  let roster: Array<{
    name: string;
    agent: AgentType;
    status: string;
    directory: string;
  }> = [];
  const nameById = new Map<string, string>();
  try {
    const sessions = queries.getAllSessions(getDb()).all() as Session[];
    for (const s of sessions) nameById.set(s.id, s.name);
    roster = sessions.map((s) => ({
      name: s.name,
      agent: s.agent_type,
      status: s.status,
      directory: s.working_directory,
    }));
  } catch {
    // DB unavailable — the analytics report + live statuses still ground a useful
    // answer; an empty roster is acceptable.
  }

  // Live sessions: status + last line under the HUMAN name (fall back to the
  // managed key if the row is gone); flag the ones that need the operator
  // (waiting AT an actual prompt) so a "what needs me?" question is answerable.
  const live = statuses.map((s) => ({
    name: nameById.get(s.id) ?? s.name,
    status: s.status,
    lastLine: s.lastLine,
    needsMe: s.status === "waiting" && s.prompt != null,
  }));
  const needsMe = live.filter((s) => s.needsMe).map((s) => s.name);

  const context = {
    generatedAt: new Date().toISOString(),
    windowDays,
    // The analytics rollup is already compact + serializable; pass it through.
    analytics: report,
    liveSessions: live,
    needsMe,
    roster,
  };

  return JSON.stringify(context, null, 2);
}

export interface RunAskOptions {
  /** Optional catalog model (e.g. "opus"); omitted → the agent's own default. */
  model?: string;
  /** Hard wall-clock cap; the child is KILLED past it so a hung/interactive
   * process can't wedge the request. */
  timeoutMs?: number;
}

const DEFAULT_ASK_TIMEOUT_MS = 60_000;

/**
 * Spawn the selected agent per buildAskArgs, write `input` to stdin (when
 * non-null) then end stdin, accumulate stdout (+ stderr for errors), and resolve
 * sanitizeDigest(stdout) on a clean exit. Rejects on a non-zero exit, a spawn
 * error, or the timeout (killing the child). Mirrors the summarize route's
 * Promise-wrapped spawn, including `shell: isWindows` + `windowsHide: isWindows`.
 */
export function runAsk(
  provider: AskProvider,
  prompt: string,
  { model, timeoutMs = DEFAULT_ASK_TIMEOUT_MS }: RunAskOptions = {}
): Promise<string> {
  const { binary, args, input } = buildAskArgs(provider, prompt, model);

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWindows,
      windowsHide: isWindows,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    // Hard timeout: kill the child so a hung or unexpectedly-interactive agent
    // can't hold the HTTP request open forever.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Ask timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(sanitizeDigest(stdout));
      } else {
        console.error(`Ask (${provider}) CLI failed:`, stderr);
        reject(new Error(`${provider} agent exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    // The prompt always rides on stdin (never argv) — see buildAskArgs.
    child.stdin.write(input);
    child.stdin.end();
  });
}
