/**
 * MCP elicitation (#48) — the in-memory pending-request store that bridges the
 * out-of-process MCP server to the operator's Stoa UI. An MCP tool POSTs a
 * request (→ createElicit), then polls its status over HTTP while it BLOCKS; the
 * operator answers in the confirm surface (→ answerElicit); the poll observes the
 * answer and the tool returns it to the agent.
 *
 * Process-local by design: the Next app is a single process, so a module-level
 * Map is shared across all API routes + the inbox read. Elicitations are
 * short-lived (one tool call); if the server restarts mid-call the entry is lost
 * and the tool's poll resolves as `cancel` — acceptable, no persistence needed.
 * All state access is server-side only (never imported into the browser bundle).
 */

import { randomUUID } from "crypto";
import type { ElicitRequest, ElicitValue } from "./elicit-schema";

export type ElicitAction = "accept" | "decline" | "cancel";

export interface ElicitAnswer {
  action: ElicitAction;
  /** Present only for `accept` — the coerced, typed field values. */
  content?: Record<string, ElicitValue>;
}

export type ElicitStatus = "pending" | "answered" | "expired";

export interface PendingElicit {
  id: string;
  conductorId: string;
  message: string;
  fields: ElicitRequest["fields"];
  status: ElicitStatus;
  answer?: ElicitAnswer;
  createdAt: number;
}

// A pending request that no operator answers is swept after this long, so a
// slow/absent human can't hold an agent's tool call — or a stale inbox card —
// forever. The MCP tool's own poll timeout should be ≤ this.
export const ELICIT_TTL_MS = 10 * 60 * 1000;
// Cap concurrent pending requests per conductor so a runaway agent can't flood
// the operator's inbox (a DoS bound).
export const MAX_PENDING_PER_CONDUCTOR = 5;

const store = new Map<string, PendingElicit>();

/** Flip any pending entry older than the TTL to `expired`. Returns how many. */
export function sweepExpired(now: number = Date.now()): number {
  let n = 0;
  for (const e of store.values()) {
    if (e.status === "pending" && now - e.createdAt >= ELICIT_TTL_MS) {
      e.status = "expired";
      n++;
    }
  }
  return n;
}

export type CreateResult =
  { ok: true; id: string } | { ok: false; error: string };

/**
 * Register a new pending elicitation for a conductor. Fails closed if the
 * conductor already has MAX_PENDING_PER_CONDUCTOR unanswered requests.
 */
export function createElicit(
  conductorId: string,
  request: ElicitRequest,
  now: number = Date.now()
): CreateResult {
  sweepExpired(now);
  const pendingForConductor = [...store.values()].filter(
    (e) => e.conductorId === conductorId && e.status === "pending"
  ).length;
  if (pendingForConductor >= MAX_PENDING_PER_CONDUCTOR) {
    return {
      ok: false,
      error: `too many pending operator-input requests (max ${MAX_PENDING_PER_CONDUCTOR})`,
    };
  }
  const id = randomUUID();
  store.set(id, {
    id,
    conductorId,
    message: request.message,
    fields: request.fields,
    status: "pending",
    createdAt: now,
  });
  return { ok: true, id };
}

/** Read one entry (with a lazy expiry sweep so a stale one reads as expired). */
export function getElicit(
  id: string,
  now: number = Date.now()
): PendingElicit | undefined {
  sweepExpired(now);
  return store.get(id);
}

export type AnswerResult = { ok: true } | { ok: false; reason: string };

/**
 * Record the operator's answer. Fails closed unless the entry is still `pending`
 * — a stale / expired / already-answered / unknown id is rejected (the TOCTOU
 * guard: an operator's late reply must not overwrite a settled request).
 */
export function answerElicit(
  id: string,
  answer: ElicitAnswer,
  now: number = Date.now()
): AnswerResult {
  sweepExpired(now);
  const e = store.get(id);
  if (!e) return { ok: false, reason: "unknown" };
  if (e.status !== "pending") return { ok: false, reason: e.status };
  e.status = "answered";
  e.answer = answer;
  return { ok: true };
}

/** Pending requests, oldest first — the operator's queue of things to answer. */
export function listPending(now: number = Date.now()): PendingElicit[] {
  sweepExpired(now);
  return [...store.values()]
    .filter((e) => e.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Test-only: clear all state so suites don't leak into each other. */
export function _resetElicitStore(): void {
  store.clear();
}
