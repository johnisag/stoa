/**
 * Session comments service layer — per-session human annotations (hand-off
 * notes, review remarks). Mirrors the Notes pattern: validation + length caps
 * live here, the DB layer stays pure SQL.
 */

import { randomUUID } from "crypto";
import { db, queries, type SessionCommentRow } from "./db";

export const COMMENT_BODY_MAX_LENGTH = 10_000;
export const COMMENT_AUTHOR_MAX_LENGTH = 120;
export const COMMENT_LIST_LIMIT = 500;

export class CommentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommentValidationError";
  }
}

/** Validate + normalize a comment body. Throws on null/undefined/empty. Pure. */
export function validateCommentBody(raw: unknown): string {
  if (raw == null) {
    throw new CommentValidationError("body is required");
  }
  if (typeof raw !== "string") {
    throw new CommentValidationError("body must be a string");
  }
  const body = raw.trim();
  if (body.length === 0) {
    throw new CommentValidationError("body must not be empty");
  }
  if (body.length > COMMENT_BODY_MAX_LENGTH) {
    throw new CommentValidationError(
      `body exceeds ${COMMENT_BODY_MAX_LENGTH} characters`
    );
  }
  return body;
}

/** Validate + normalize an author label. Empty allowed (anonymous). Pure. */
export function normalizeCommentAuthor(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw !== "string") {
    throw new CommentValidationError("author must be a string");
  }
  const author = raw.trim();
  if (author.length > COMMENT_AUTHOR_MAX_LENGTH) {
    throw new CommentValidationError(
      `author exceeds ${COMMENT_AUTHOR_MAX_LENGTH} characters`
    );
  }
  return author;
}

/** Create a comment on a session. Returns the stored row. */
export function createComment(input: {
  sessionId: string;
  body: unknown;
  author?: unknown;
}): SessionCommentRow {
  if (!input.sessionId || typeof input.sessionId !== "string") {
    throw new CommentValidationError("sessionId is required");
  }
  const body = validateCommentBody(input.body);
  const author = normalizeCommentAuthor(input.author);
  const id = randomUUID();
  queries.createSessionComment(db).run(id, input.sessionId, author, body);
  return queries.getSessionComment(db).get(id) as SessionCommentRow;
}

/** List comments for a session, oldest first (bounded by COMMENT_LIST_LIMIT). */
export function listComments(sessionId: string): SessionCommentRow[] {
  if (!sessionId || typeof sessionId !== "string") return [];
  return queries
    .listSessionComments(db)
    .all(sessionId, COMMENT_LIST_LIMIT) as SessionCommentRow[];
}

/** Update a comment's body, scoped to the given session. Returns the updated
 *  row or null when the comment doesn't exist or doesn't belong to the session. */
export function updateComment(
  sessionId: string,
  commentId: string,
  body: unknown
): SessionCommentRow | null {
  if (!sessionId || !commentId) return null;
  const validated = validateCommentBody(body);
  const result = queries
    .updateSessionComment(db)
    .run(validated, commentId, sessionId);
  if (result.changes === 0) return null;
  return queries.getSessionComment(db).get(commentId) as SessionCommentRow;
}

/** Delete a comment by id, scoped to the given session. Returns true when removed. */
export function deleteComment(sessionId: string, commentId: string): boolean {
  if (!sessionId || !commentId) return false;
  return queries.deleteSessionComment(db).run(commentId, sessionId).changes > 0;
}

/** Delete all comments for a session (called on session deletion). */
export function deleteCommentsForSession(sessionId: string): number {
  if (!sessionId || typeof sessionId !== "string") return 0;
  return queries.deleteSessionCommentsForSession(db).run(sessionId).changes;
}
