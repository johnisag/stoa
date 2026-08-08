/**
 * Agent-to-agent session operations — the Stoa equivalent of Herdr's
 * `herdr agent wait`, `herdr agent read`, and `herdr agent prompt` commands.
 *
 * These are the primitives that enable agent-to-agent coordination within
 * Stoa: an agent (or external script) can:
 *   - READ a session's rendered screen (what's on the terminal right now)
 *   - WAIT for a session to reach a specific state (blocked/idle/error/running)
 *   - PROMPT a session (send text input + optionally wait for the response)
 *
 * Security:
 *   - READ uses the same capture() the status poll uses (read-only, no side
 *     effects on the pty).
 *   - WAIT is a poll loop that reads the status detector (same path the Fleet
 *     Board uses), with a hard timeout so a hung wait can't hold a connection.
 *   - PROMPT delegates to the existing send-keys route's security (control
 *     char filtering, length cap). The prompt text is validated by the caller.
 *
 * All operations are server-side; the session id is validated against the DB
 * (same genericSessionRouteAccess gate every session route uses).
 */

import { getDb, queries, type Session } from "./db";
import { backendKeyForSession } from "./providers/registry";
import { getSessionBackend } from "./session-backend";
import { statusDetector, type SessionStatus } from "./status-detector";
import {
  assertGenericSessionRouteAccess,
  genericSessionRouteFailure,
} from "./session-route-access";
import { SEND_KEYS_MAX_LENGTH } from "./api-security";

/**
 * Reject C0 control characters except tab and newline — same guard as the
 * send-keys route. Kept here so promptSession is self-contained and safe
 * regardless of caller.
 */
function hasDisallowedControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10) return true;
    if (code === 127) return true;
  }
  return false;
}

/** The states an agent-to-agent wait can watch for. */
export type WaitTargetStatus =
  "running" | "waiting" | "idle" | "error" | "dead";

/** Result of a wait operation. */
export interface WaitResult {
  /** The final status when the wait resolved (matched or timed out). */
  status: SessionStatus;
  /** True if the target status was reached before the timeout. */
  matched: boolean;
  /** How long the wait took in milliseconds. */
  elapsedMs: number;
  /** The last non-empty line on the rendered screen (for context). */
  lastLine: string;
}

/** Default poll interval for wait operations (matches the status tick). */
const DEFAULT_POLL_INTERVAL_MS = 1000;

/** Default timeout for wait operations (prevents indefinite holding). */
const DEFAULT_WAIT_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Read the rendered screen content of a session — the Stoa equivalent of
 * Herdr's `herdr agent read <pane>`. Returns the captured screen text and
 * the last non-empty line, WITHOUT sending any input to the session.
 *
 * Server-side: validates the session exists and is accessible.
 */
export async function readSession(
  sessionId: string,
  maxLines?: number
): Promise<
  | { ok: true; content: string; lastLine: string; status: SessionStatus }
  | { ok: false; error: string; status: number }
> {
  const db = getDb();
  const session = queries.getSession(db).get(sessionId) as Session | undefined;

  const denied = genericSessionRouteFailure(session);
  if (denied) return { ok: false, error: denied.error, status: denied.status };
  assertGenericSessionRouteAccess(session);

  const key = backendKeyForSession(session);
  const backend = getSessionBackend();

  if (!(await backend.exists(key))) {
    return {
      ok: false,
      error: "Session is not running",
      status: 400,
    };
  }

  const content = await backend.capture(key);
  const detail = await statusDetector.getStatusDetail(key);
  const trimmed = content.trim();
  const lines = trimmed.split("\n");
  const limited = maxLines ? lines.slice(-maxLines).join("\n") : trimmed;

  return {
    ok: true,
    content: limited,
    lastLine: detail.lastLine,
    status: detail.status,
  };
}

/**
 * Wait for a session to reach a target status — the Stoa equivalent of
 * Herdr's `herdr agent wait <target> --state blocked`.
 *
 * Polls the status detector at regular intervals until the target status is
 * reached or the timeout expires. The status detector does the actual screen
 * capture and classification; this function just polls and compares.
 *
 * Returns immediately if the session is dead or the target is already met.
 */
export async function waitForSessionStatus(
  sessionId: string,
  targetStatus: WaitTargetStatus,
  options?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
  }
): Promise<
  | { ok: true; result: WaitResult }
  | { ok: false; error: string; status: number }
> {
  const db = getDb();
  const session = queries.getSession(db).get(sessionId) as Session | undefined;

  const denied = genericSessionRouteFailure(session);
  if (denied) return { ok: false, error: denied.error, status: denied.status };
  assertGenericSessionRouteAccess(session);

  const key = backendKeyForSession(session);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startedAt = Date.now();

  // Check if the session exists at all
  const backend = getSessionBackend();
  if (!(await backend.exists(key))) {
    return {
      ok: false,
      error: "Session is not running",
      status: 400,
    };
  }

  // Poll loop
  let lastStatus: SessionStatus = "running";
  let lastLine = "";
  while (Date.now() - startedAt < timeoutMs) {
    const detail = await statusDetector.getStatusDetail(key);
    lastStatus = detail.status;
    lastLine = detail.lastLine;

    if (detail.status === targetStatus) {
      return {
        ok: true,
        result: {
          status: detail.status,
          matched: true,
          elapsedMs: Date.now() - startedAt,
          lastLine,
        },
      };
    }

    // If the session died, stop waiting
    if (detail.status === "dead") {
      return {
        ok: true,
        result: {
          status: "dead",
          matched: targetStatus === "dead",
          elapsedMs: Date.now() - startedAt,
          lastLine,
        },
      };
    }

    await sleep(pollIntervalMs);
  }

  // Timeout — return the last-known status
  return {
    ok: true,
    result: {
      status: lastStatus,
      matched: false,
      elapsedMs: Date.now() - startedAt,
      lastLine,
    },
  };
}

/**
 * Send a prompt to a session — the Stoa equivalent of Herdr's
 * `herdr agent prompt <target> <text>`. Sends text input via the session
 * backend's pasteText, optionally followed by waiting for a target status.
 *
 * Security: the prompt text is sent through the same pasteText path the
 * send-keys route uses — control char filtering and length capping are the
 * caller's responsibility (the API route validates before calling this).
 */
export async function promptSession(
  sessionId: string,
  text: string,
  options?: {
    pressEnter?: boolean;
    waitFor?: WaitTargetStatus;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }
): Promise<
  | {
      ok: true;
      sent: boolean;
      waitResult?: WaitResult;
    }
  | { ok: false; error: string; status: number }
> {
  // Defense-in-depth: enforce the same controls the send-keys route applies,
  // so promptSession is safe regardless of caller. Without this, a library
  // consumer could bypass length/character validation.
  if (!text) {
    return { ok: false, error: "No text provided", status: 400 };
  }
  if (text.length > SEND_KEYS_MAX_LENGTH) {
    return {
      ok: false,
      error: `Text exceeds maximum length of ${SEND_KEYS_MAX_LENGTH}`,
      status: 400,
    };
  }
  if (hasDisallowedControlChars(text)) {
    return {
      ok: false,
      error: "Text contains disallowed control characters",
      status: 400,
    };
  }

  const db = getDb();
  const session = queries.getSession(db).get(sessionId) as Session | undefined;

  const denied = genericSessionRouteFailure(session);
  if (denied) return { ok: false, error: denied.error, status: denied.status };
  assertGenericSessionRouteAccess(session);

  const key = backendKeyForSession(session);
  const backend = getSessionBackend();

  if (!(await backend.exists(key))) {
    return {
      ok: false,
      error: "Session is not running",
      status: 400,
    };
  }

  // Send the prompt
  await backend.pasteText(key, text, { enter: options?.pressEnter ?? true });

  // Optionally wait for a target status
  if (options?.waitFor) {
    const wait = await waitForSessionStatus(sessionId, options.waitFor, {
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
    });
    if (!wait.ok) return wait;
    return { ok: true, sent: true, waitResult: wait.result };
  }

  return { ok: true, sent: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
