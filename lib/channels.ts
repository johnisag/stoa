/**
 * Inter-agent channels — the service layer for persistent 1:1 messages between
 * two sessions. Both the agents (the orchestration MCP server's channel_* tools)
 * and any human UI read/write through the SAME /api/channels route — amux's "the
 * human UI and the agents call the exact same endpoint" pattern (item #3).
 *
 * Where it fits among the data tools:
 *   - agent_memory (lib/agent-memory.ts) — a fleet-wide key→value scratchpad.
 *   - notes (lib/notes.ts)               — shared markdown docs ("things to read").
 *   - channels (here)                    — DIRECTED, point-to-point messages so the
 *     worker that owns lib/db/schema.ts can tell the worker that owns lib/dispatch/
 *     "the column is named X". A conversation between two sessions, not a board.
 *
 * Two delivery modes, mirroring amux:
 *   - PULL (always on): the recipient calls channel_inbox and the unread messages
 *     land in its context as data. Consuming — a read marks them read so the next
 *     poll only returns what's new.
 *   - PUSH (opt-in, default-off — lib/channel-delivery.ts + server.ts): at a clean
 *     turn boundary the server injects ONE unread message into the recipient's
 *     terminal with a hardened wrapper. Off by default because writing into a
 *     session unattended is the risky part (same stance as STOA_AUTO_RESUME).
 *
 * Thin shell over the prepared statements in lib/db/queries/; id generation,
 * the order-independent pair key, validation + length caps live here (the DB layer
 * stays pure SQL), mirroring lib/notes.ts.
 */

import { randomUUID } from "crypto";
import { db, getDb, queries, type ChannelMessageRow, type Session } from "./db";
import { isInteractiveSessionRole } from "./session-role";

/** Max message body length — a coordination message, not a document. Bounded
 * tighter than a note because the opt-in push pastes it into a live terminal. */
export const CHANNEL_BODY_MAX_LENGTH = 10_000;
/** Max messages returned by an inbox/thread read. */
export const CHANNEL_LIST_LIMIT = 200;

/** A validation failure (the API route maps this to a 400). */
export class ChannelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelValidationError";
  }
}

/** Validate + normalize a session id arg: a non-empty trimmed string. Pure. */
export function normalizeSessionId(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ChannelValidationError(`${label} is required`);
  }
  return raw.trim();
}

/** Validate a message body: a non-empty string within the cap. Throws otherwise.
 * Pure → unit-tested. (Empty is rejected — an empty message is never intentional
 * and would inject a bare wrapper into a terminal under the opt-in push.) */
export function validateChannelBody(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ChannelValidationError("message must be a string");
  }
  const body = raw.trim();
  if (!body) throw new ChannelValidationError("message is required");
  if (body.length > CHANNEL_BODY_MAX_LENGTH) {
    throw new ChannelValidationError(
      `message exceeds ${CHANNEL_BODY_MAX_LENGTH} characters`
    );
  }
  return body;
}

/** Order-independent thread id for a pair of session ids: sort + join so a
 * message in either direction maps to the same conversation. Pure → unit-tested.
 * Session ids are UUIDs (no "__"), so the separator can't collide. */
export function channelPairKey(a: string, b: string): string {
  return [a, b].sort().join("__");
}

function interactiveSession(id: string): Session | null {
  const session = queries.getSession(db).get(id) as Session | undefined;
  return session && isInteractiveSessionRole(session) ? session : null;
}

function requireInteractiveSession(id: string): Session {
  const session = interactiveSession(id);
  if (!session) {
    // Use the same response for missing and server-owned ids so this generic
    // service neither addresses nor discloses internal sessions.
    throw new ChannelValidationError(`no session with id "${id}"`);
  }
  return session;
}

function isInteractiveMessage(message: ChannelMessageRow): boolean {
  return (
    interactiveSession(message.from_session_id) !== null &&
    interactiveSession(message.to_session_id) !== null
  );
}

/** Send a message from one session to another. Validates the body, rejects a
 * self-send, and requires BOTH ends to be known sessions (a typo'd id is far more
 * likely than messaging a not-yet-created session — and validating `from` stops a
 * phantom-sender row). Note: the HTTP layer trusts localhost like the sibling
 * /api/memory + /api/notes routes, so `from` is not authenticated there; the MCP
 * channel_send tool resolves `from` from the baked CONDUCTOR_SESSION_ID (which
 * always wins over an arg), so an agent can't spoof its own sender. Returns the
 * stored row. */
export function sendChannelMessage(input: {
  from: unknown;
  to: unknown;
  body: unknown;
}): ChannelMessageRow {
  const from = normalizeSessionId(input.from, "from");
  const to = normalizeSessionId(input.to, "to");
  const body = validateChannelBody(input.body);
  if (from === to) {
    throw new ChannelValidationError("cannot send a message to yourself");
  }
  requireInteractiveSession(from);
  requireInteractiveSession(to);
  const id = randomUUID();
  queries
    .createChannelMessage(db)
    .run(id, channelPairKey(from, to), from, to, body);
  return getChannelMessage(id) as ChannelMessageRow;
}

/** Read one message by id, or null. File-local (only the just-inserted row is
 * read back, for sendChannelMessage's return value). */
function getChannelMessage(id: string): ChannelMessageRow | null {
  return (
    (queries.getChannelMessage(db).get(id) as ChannelMessageRow | undefined) ??
    null
  );
}

/** Peek the unread inbox for a session (NON-consuming), oldest first. */
export function peekInbox(sessionId: string): ChannelMessageRow[] {
  const id = normalizeSessionId(sessionId, "session");
  requireInteractiveSession(id);
  return (
    queries
      .listChannelInbox(db)
      .all(id, CHANNEL_LIST_LIMIT) as ChannelMessageRow[]
  ).filter(isInteractiveMessage);
}

/** Read + CONSUME the unread inbox for a session: returns the unread messages
 * (oldest first) and marks them read so the next poll only returns what's new.
 * The SELECT and the mark-read run in ONE transaction so two concurrent callers
 * (a retrying agent, a double-tap) can't both read the same messages — the second
 * transaction's SELECT runs after the first's marks and sees an empty inbox. */
export function consumeInbox(sessionId: string): ChannelMessageRow[] {
  const id = normalizeSessionId(sessionId, "session");
  requireInteractiveSession(id);
  const list = queries.listChannelInbox(db);
  const mark = queries.markChannelRead(db);
  return getDb().transaction(() => {
    const unread = (
      list.all(id, CHANNEL_LIST_LIMIT) as ChannelMessageRow[]
    ).filter(isInteractiveMessage);
    for (const m of unread) mark.run(m.id);
    return unread;
  })();
}

/** The single oldest unread message for a recipient (NON-consuming) — the opt-in
 * push delivers this one, then marks it delivered. Returns null when the inbox is
 * empty. */
export function nextUnreadMessage(sessionId: string): ChannelMessageRow | null {
  const id = normalizeSessionId(sessionId, "session");
  requireInteractiveSession(id);
  const unread = queries
    .listChannelInbox(db)
    .all(id, CHANNEL_LIST_LIMIT) as ChannelMessageRow[];
  return unread.find(isInteractiveMessage) ?? null;
}

/**
 * Atomically CLAIM a message for the opt-in terminal push and report whether
 * THIS caller won the claim. A single UPDATE stamps delivered_at + read_at
 * WHERE the row is still pending (delivered_at IS NULL AND read_at IS NULL);
 * `changes === 1` means this caller flipped it and is the one allowed to paste.
 *
 * This closes the double-deliver race: the old flow peeked the row
 * (nextUnreadMessage, non-consuming), pasted, then marked — so two concurrent
 * delivery attempts both saw the row as unread and both pasted. Claiming BEFORE
 * the paste means only one caller ever pastes. It also loses to a prior pull
 * (channel_inbox) that already set read_at — the guard returns 0 changes, so the
 * pushed copy is skipped and the pulled/pushed state stays coherent.
 */
export function claimDelivery(id: string): boolean {
  const message = getChannelMessage(id);
  if (!message || !isInteractiveMessage(message)) return false;
  return queries.markChannelDelivered(db).run(id).changes === 1;
}

/**
 * Un-claim a message this push CLAIMED but failed to paste, returning it to the
 * pending state so the NEXT tick re-delivers it. Without this a transient paste
 * failure (the recipient pane died between the tick's snapshot and the paste, a
 * tmux exec hiccup) would leave the row stamped delivered+read — invisible to
 * both the push scan and the pull inbox — silently and permanently undelivered.
 * Only reverts a push-claimed row (delivered_at set); never un-consumes a pull.
 */
export function resetDelivery(id: string): void {
  queries.resetChannelDelivery(db).run(id);
}

/** Delete every channel message a session sent OR received — orphan cleanup when
 * the session is hard-deleted (no FK cascade exists on channel_messages). */
export function deleteChannelMessagesForSession(sessionId: string): number {
  return queries.deleteChannelMessagesForSession(db).run(sessionId, sessionId)
    .changes;
}

/** The distinct recipients that currently have at least one unread message —
 * one SELECT DISTINCT instead of probing every live session's inbox per tick.
 * Order is by the recipient id (deterministic); the per-recipient pick still
 * uses nextUnreadMessage for the oldest unread. */
export function sessionsWithPendingDelivery(): string[] {
  return (
    queries.listPendingChannelRecipients(db).all() as {
      to_session_id: string;
    }[]
  )
    .map((r) => r.to_session_id)
    .filter((id) => {
      if (!interactiveSession(id)) return false;
      const unread = queries
        .listChannelInbox(db)
        .all(id, CHANNEL_LIST_LIMIT) as ChannelMessageRow[];
      return unread.some(isInteractiveMessage);
    });
}

/** The full conversation between two sessions (both directions), oldest first.
 * NON-consuming — a review of the thread, distinct from the consuming inbox. */
export function listThread(a: unknown, b: unknown): ChannelMessageRow[] {
  const idA = normalizeSessionId(a, "session");
  const idB = normalizeSessionId(b, "peer");
  requireInteractiveSession(idA);
  requireInteractiveSession(idB);
  return (
    queries
      .listChannelThread(db)
      .all(channelPairKey(idA, idB), CHANNEL_LIST_LIMIT) as ChannelMessageRow[]
  ).filter(isInteractiveMessage);
}
