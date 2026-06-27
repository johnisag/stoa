/**
 * Notes / shared knowledge base — the service layer for persistent markdown docs.
 * Both the human UI (a Notes dialog) and agents (the orchestration MCP server's
 * notes_* tools) read/write through the SAME /api/notes route — amux's "the human
 * UI and the agents call the exact same endpoint" pattern (item #3), the surface
 * that makes a knowledge base agent-usable, not human-only.
 *
 * Discipline (amux's): notes = things to READ (the interface contract, a handoff,
 * a discovered gotcha); the Dispatch board = things to DO. Notes are fleet-shared
 * and pinnable. Like the shared memory (lib/agent-memory.ts), a note's content
 * lands in a reader's context as DATA (an agent fetches a note on demand) — it is
 * never auto-injected into a terminal, so there's no keystroke-injection surface.
 *
 * Thin shell over the prepared statements in lib/db/queries.ts; id/validation +
 * length caps live here (the DB layer stays pure SQL), mirroring
 * lib/saved-workflows.ts.
 */

import { randomUUID } from "crypto";
import { db, queries, type NoteRow } from "./db";

/** Max note title length — a short label, not the body. */
export const NOTE_TITLE_MAX_LENGTH = 256;
/** Max note body length — generous for a markdown doc, but bounded per row. */
export const NOTE_CONTENT_MAX_LENGTH = 200_000;
/** Max notes returned by a list. */
export const NOTE_LIST_LIMIT = 500;

/** A validation failure (the API route maps this to a 400). */
export class NoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteValidationError";
  }
}

/** Validate + normalize a title: a trimmed string within the cap (empty allowed —
 * an untitled note is fine). Throws NoteValidationError when not a string / too
 * long. Pure → unit-tested. */
export function normalizeNoteTitle(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw !== "string") {
    throw new NoteValidationError("title must be a string");
  }
  const title = raw.trim();
  if (title.length > NOTE_TITLE_MAX_LENGTH) {
    throw new NoteValidationError(
      `title exceeds ${NOTE_TITLE_MAX_LENGTH} characters`
    );
  }
  return title;
}

/** Validate note content: a string within the cap (empty allowed). Throws
 * NoteValidationError otherwise. Pure. */
export function validateNoteContent(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw !== "string") {
    throw new NoteValidationError("content must be a string");
  }
  if (raw.length > NOTE_CONTENT_MAX_LENGTH) {
    throw new NoteValidationError(
      `content exceeds ${NOTE_CONTENT_MAX_LENGTH} characters`
    );
  }
  return raw;
}

/** Coerce a `pinned` input to a SQLite 0/1. Accepts boolean / 0 / 1; anything
 * else is rejected so a stray value can't silently un/pin. */
export function normalizeNotePinned(raw: unknown): 0 | 1 {
  if (raw === true || raw === 1) return 1;
  if (raw === false || raw === 0 || raw == null) return 0;
  throw new NoteValidationError("pinned must be a boolean");
}

/** Create a note. Validates first; returns the stored row. */
export function createNote(input: {
  title?: unknown;
  content?: unknown;
  pinned?: unknown;
}): NoteRow {
  const id = randomUUID();
  const title = normalizeNoteTitle(input.title);
  const content = validateNoteContent(input.content);
  const pinned = normalizeNotePinned(input.pinned);
  queries.createNote(db).run(id, title, content, pinned);
  return queries.getNote(db).get(id) as NoteRow;
}

/** Read one note by id, or null when it doesn't exist. */
export function getNote(id: string): NoteRow | null {
  return (queries.getNote(db).get(id) as NoteRow | undefined) ?? null;
}

/** List notes — pinned first, then most-recently-updated (bounded). */
export function listNotes(): NoteRow[] {
  return queries.listNotes(db).all(NOTE_LIST_LIMIT) as NoteRow[];
}

/** Partial-update a note (only the provided fields change). Returns the updated
 * row, or null when the id doesn't exist. Validates the provided fields. */
export function updateNote(
  id: string,
  patch: { title?: unknown; content?: unknown; pinned?: unknown }
): NoteRow | null {
  const existing = getNote(id);
  if (!existing) return null;
  const title =
    patch.title !== undefined
      ? normalizeNoteTitle(patch.title)
      : existing.title;
  const content =
    patch.content !== undefined
      ? validateNoteContent(patch.content)
      : existing.content;
  const pinned =
    patch.pinned !== undefined
      ? normalizeNotePinned(patch.pinned)
      : (existing.pinned as 0 | 1);
  queries.updateNote(db).run(title, content, pinned, id);
  return queries.getNote(db).get(id) as NoteRow;
}

/** Delete a note by id. Returns true when a row was removed. */
export function deleteNote(id: string): boolean {
  return queries.deleteNote(db).run(id).changes > 0;
}
