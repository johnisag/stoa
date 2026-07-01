import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { statusDetector, type SessionStatus } from "@/lib/status-detector";
import type { RateLimitState } from "@/lib/rate-limit";
import type { AgentType } from "@/lib/providers";
import {
  getManagedSessionPattern,
  getProviderIdFromSessionName,
  getSessionIdFromName,
} from "@/lib/providers/registry";
import { getDb } from "@/lib/db";
import { getSessionBackend } from "@/lib/session-backend";
import { claudeProjectDirName, findClaudeProjectDir } from "@/lib/platform";
import { getBudgetStage, isBudgetParked } from "@/lib/budget-park";

const backend = getSessionBackend();

interface SessionStatusResponse {
  sessionName: string;
  status: SessionStatus;
  lastLine?: string;
  claudeSessionId?: string | null;
  agentType?: AgentType;
  /** Rate-limit state off the rendered screen (null when not limited). */
  rateLimit?: RateLimitState | null;
  /** True when an ACTUAL prompt is on screen (vs "waiting" = finished its turn). */
  hasPrompt?: boolean;
  /** #19 verify badge: last turn-boundary verdict (running/pass/fail/error),
   * when it ran, and a short failing-output head for the tooltip. */
  verifyStatus?: string | null;
  verifyRanAt?: string | null;
  verifyOutput?: string | null;
  /** #21 budget badge: the session's stage vs its budget cap (ok/warn80/cap)
   * and whether the tick has PARKED it (fail-closed, no new work fed). */
  budgetStage?: string;
  budgetParked?: boolean;
}

async function getTmuxSessions(): Promise<string[]> {
  return backend.list();
}

async function getTmuxSessionCwd(sessionName: string): Promise<string | null> {
  return backend.getPanePath(sessionName);
}

// Get Claude session ID from tmux environment variable
async function getClaudeSessionIdFromEnv(
  sessionName: string
): Promise<string | null> {
  const sessionId = await backend.getEnv(sessionName, "CLAUDE_SESSION_ID");
  if (sessionId && sessionId !== "null") {
    return sessionId;
  }
  return null;
}

// Get Claude session ID by looking at session files on disk
function getClaudeSessionIdFromFiles(projectPath: string): string | null {
  const home = os.homedir();
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  // Derive the on-disk project dir using the shared, cross-platform encoder.
  // Honor CLAUDE_CONFIG_DIR via the encoded name; otherwise resolve the actual
  // dir (tolerant of casing) under the default ~/.claude/projects.
  const projectDir = process.env.CLAUDE_CONFIG_DIR
    ? path.join(claudeDir, "projects", claudeProjectDirName(projectPath))
    : findClaudeProjectDir(projectPath);

  if (!projectDir || !fs.existsSync(projectDir)) {
    return null;
  }

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

  try {
    const files = fs.readdirSync(projectDir);
    let mostRecent: string | null = null;
    let mostRecentTime = 0;

    for (const file of files) {
      if (file.startsWith("agent-")) continue;
      if (!uuidPattern.test(file)) continue;

      const filePath = path.join(projectDir, file);
      const stat = fs.statSync(filePath);

      if (stat.mtimeMs > mostRecentTime) {
        mostRecentTime = stat.mtimeMs;
        mostRecent = file.replace(".jsonl", "");
      }
    }

    if (mostRecent && Date.now() - mostRecentTime < 5 * 60 * 1000) {
      return mostRecent;
    }

    const configFile = path.join(claudeDir, ".claude.json");
    if (fs.existsSync(configFile)) {
      try {
        const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
        if (
          isClaudeConfig(config) &&
          typeof config.projects === "object" &&
          config.projects !== null &&
          typeof config.projects[projectPath] === "object" &&
          config.projects[projectPath] !== null &&
          typeof config.projects[projectPath].lastSessionId === "string"
        ) {
          return config.projects[projectPath].lastSessionId;
        }
      } catch {
        // Ignore config parse errors
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function getClaudeSessionId(sessionName: string): Promise<string | null> {
  const envId = await getClaudeSessionIdFromEnv(sessionName);
  if (envId) {
    return envId;
  }

  const cwd = await getTmuxSessionCwd(sessionName);
  if (cwd) {
    return getClaudeSessionIdFromFiles(cwd);
  }

  return null;
}

// Resolve an agent's own session id (used later for `--resume`/`--session <id>`),
// per provider. Claude reads its env var / on-disk project files; Hermes prints
// the id in its startup banner, which the status detector captures from the
// rendered screen (Hermes writes no session file until clean exit); Kimi Code
// ALSO prints its id in its banner, captured the same per-session way. Stored in
// the shared `claude_session_id` column. Other agents have no resume id.
async function getProviderSessionId(
  sessionName: string,
  agentType: AgentType
): Promise<string | null> {
  if (agentType === "hermes") {
    return statusDetector.getHermesSessionId(sessionName);
  }
  if (agentType === "claude") {
    return getClaudeSessionId(sessionName);
  }
  if (agentType === "kimi") {
    // Per-session id from Kimi Code's startup banner (captured from the rendered
    // screen by the status detector), exactly like Hermes — being per-session it
    // never confuses two sessions that share a cwd. Banner-only on purpose: a
    // cwd-keyed on-disk fallback could resolve a stale same-cwd id.
    return statusDetector.getKimiSessionId(sessionName);
  }
  return null;
}

// UUID pattern for stoa managed sessions (derived from registry)
const UUID_PATTERN = getManagedSessionPattern();

// Track previous statuses to detect changes
const previousStatuses = new Map<string, SessionStatus>();

// Resolved agent resume-id per session (keyed by the stable stoa session id).
// Resolving it re-scans the Claude project dir on disk (fs reads) every poll;
// once we've found it, it's effectively fixed for the session's life, so we
// cache it and stop re-scanning. (Trade-off: if a user starts a brand-new
// conversation inside the same session, we keep the first id — acceptable, and
// the explicit intent of the perf follow-up.) Pruned with previousStatuses.
const resolvedSessionIds = new Map<string, string>();

function getAgentTypeFromSessionName(sessionName: string): AgentType {
  return getProviderIdFromSessionName(sessionName) || "claude";
}

export async function GET() {
  try {
    const sessions = await getTmuxSessions();

    // Get status for stoa managed sessions
    const managedSessions = sessions.filter((s) => UUID_PATTERN.test(s));

    // Use the new status detector
    const statusMap: Record<string, SessionStatusResponse> = {};

    const db = getDb();
    const sessionsToUpdate: string[] = [];

    // Process all sessions in parallel for speed
    const sessionPromises = managedSessions.map(async (sessionName) => {
      const agentType = getAgentTypeFromSessionName(sessionName);
      const id = getSessionIdFromName(sessionName);
      // One screen capture yields the status, the preview line, rate-limit, and
      // whether an actual prompt is on screen.
      const { status, lastLine, rateLimit, prompt } =
        await statusDetector.getStatusDetail(sessionName);
      // Resolve the agent resume-id AFTER getStatusDetail: its capturePane()
      // populates the Hermes banner-id cache, so reading it here captures the id
      // on the same poll the banner is visible rather than one poll behind. Skip
      // the (fs-scanning) resolution entirely once we already know it.
      let claudeSessionId = resolvedSessionIds.get(id) ?? null;
      if (!claudeSessionId) {
        claudeSessionId = await getProviderSessionId(sessionName, agentType);
        if (claudeSessionId) resolvedSessionIds.set(id, claudeSessionId);
      }

      return {
        sessionName,
        id,
        status,
        claudeSessionId,
        lastLine,
        agentType,
        rateLimit,
        hasPrompt: prompt != null,
      };
    });

    const results = await Promise.all(sessionPromises);

    // #19: attach the last verify verdict (written by the server tick's
    // sessionVerifyTick) so the card can render the badge. The failing-output
    // tail is capped small here — the tooltip needs a hint, not the full 8KB.
    const verifyStmt = db.prepare(
      "SELECT verify_status, verify_output, verify_ran_at FROM sessions WHERE id = ?"
    );

    for (const {
      sessionName,
      id,
      status,
      claudeSessionId,
      lastLine,
      agentType,
      rateLimit,
      hasPrompt,
    } of results) {
      // Track status changes - update DB when session becomes active
      const prevStatus = previousStatuses.get(id);
      if (status === "running" || status === "waiting" || status === "error") {
        if (prevStatus !== status) {
          sessionsToUpdate.push(id);
        }
      }
      previousStatuses.set(id, status);

      const v = verifyStmt.get(id) as
        | {
            verify_status?: string | null;
            verify_output?: string | null;
            verify_ran_at?: string | null;
          }
        | undefined;

      statusMap[id] = {
        sessionName,
        status,
        lastLine,
        claudeSessionId,
        agentType,
        rateLimit,
        hasPrompt,
        verifyStatus: v?.verify_status ?? null,
        verifyRanAt: v?.verify_ran_at ?? null,
        verifyOutput: v?.verify_output ? v.verify_output.slice(0, 400) : null,
        budgetStage: getBudgetStage(id),
        budgetParked: isBudgetParked(id),
      };
    }

    // Batch update sessions and claude_session_id in a single transaction
    const updateStatusStmt = db.prepare(
      "UPDATE sessions SET updated_at = datetime('now') WHERE id = ?"
    );
    const updateClaudeIdStmt = db.prepare(
      "UPDATE sessions SET claude_session_id = ? WHERE id = ? AND (claude_session_id IS NULL OR claude_session_id != ?)"
    );

    for (const id of sessionsToUpdate) {
      updateStatusStmt.run(id);
    }

    // Update claude_session_id directly here instead of requiring separate API calls
    for (const { id, claudeSessionId } of results) {
      if (claudeSessionId) {
        updateClaudeIdStmt.run(claudeSessionId, id, claudeSessionId);
      }
    }

    // Cleanup old trackers
    statusDetector.cleanup();

    // Prune our own per-session maps for sessions that no longer exist, so they
    // don't leak over a long-lived server process.
    const liveIds = new Set(results.map((r) => r.id));
    for (const id of previousStatuses.keys()) {
      if (!liveIds.has(id)) previousStatuses.delete(id);
    }
    for (const id of resolvedSessionIds.keys()) {
      if (!liveIds.has(id)) resolvedSessionIds.delete(id);
    }

    return NextResponse.json({ statuses: statusMap });
  } catch (error) {
    console.error("Error getting session statuses:", error);
    const message =
      error instanceof Error ? error.message : "Backend status check failed";
    return NextResponse.json({ error: message, statuses: {} }, { status: 503 });
  }
}

interface ClaudeConfig {
  projects?: Record<string, { lastSessionId?: string }>;
}

function isClaudeConfig(value: unknown): value is ClaudeConfig {
  return typeof value === "object" && value !== null;
}
