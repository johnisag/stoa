/**
 * Notes / shared knowledge base — the service layer over a real in-memory SQLite
 * (real schema + migrations + queries, the `db` proxy mocked). Locks create / get
 * / list / partial-update / delete, list ordering (pinned first then newest), the
 * partial-update merge (only provided fields change), and the validation caps.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    getDb: () => state.db,
    get db() {
      return state.db;
    },
  };
});

import {
  createNote,
  getNote,
  listNotes,
  updateNote,
  deleteNote,
  normalizeNoteTitle,
  validateNoteContent,
  normalizeNotePinned,
  NoteValidationError,
  NOTE_TITLE_MAX_LENGTH,
  NOTE_CONTENT_MAX_LENGTH,
} from "@/lib/notes";

function db() {
  return state.db as InstanceType<typeof Database>;
}

beforeAll(() => {
  const d = new Database(":memory:");
  createSchema(d);
  runMigrations(d);
  state.db = d;
});

beforeEach(() => {
  db().prepare("DELETE FROM notes").run();
});

describe("createNote / getNote", () => {
  it("creates a note and reads it back by id", () => {
    const note = createNote({
      title: "Contract",
      content: "# API\nreturns ok",
    });
    expect(note.id).toBeTruthy();
    expect(note.title).toBe("Contract");
    expect(note.content).toBe("# API\nreturns ok");
    expect(note.pinned).toBe(0);
    expect(getNote(note.id)?.content).toBe("# API\nreturns ok");
  });

  it("defaults title/content to empty and pinned to 0", () => {
    const note = createNote({});
    expect(note.title).toBe("");
    expect(note.content).toBe("");
    expect(note.pinned).toBe(0);
  });

  it("returns null for an unknown id", () => {
    expect(getNote("nope")).toBeNull();
  });
});

describe("listNotes", () => {
  it("lists pinned notes first, then most-recently-updated", () => {
    const a = createNote({ title: "a" });
    const b = createNote({ title: "b" });
    const c = createNote({ title: "c" });
    // Pin b; make a the newest unpinned (touch updated_at).
    updateNote(b.id, { pinned: true });
    db()
      .prepare(
        "UPDATE notes SET updated_at = '2099-01-01 00:00:00' WHERE id = ?"
      )
      .run(a.id);
    const order = listNotes().map((n) => n.title);
    expect(order[0]).toBe("b"); // pinned wins
    expect(order[1]).toBe("a"); // newest unpinned next
    expect(order[2]).toBe("c");
  });

  it("is empty when there are no notes", () => {
    expect(listNotes()).toEqual([]);
  });
});

describe("updateNote (partial)", () => {
  it("changes ONLY the provided fields", () => {
    const note = createNote({ title: "t", content: "c" });
    const updated = updateNote(note.id, { content: "c2" })!;
    expect(updated.title).toBe("t"); // untouched
    expect(updated.content).toBe("c2");
    // Pin without touching title/content.
    const pinned = updateNote(note.id, { pinned: true })!;
    expect(pinned.pinned).toBe(1);
    expect(pinned.title).toBe("t");
    expect(pinned.content).toBe("c2");
  });

  it("returns null when the id doesn't exist (no row created)", () => {
    expect(updateNote("ghost", { title: "x" })).toBeNull();
    expect(listNotes()).toHaveLength(0);
  });
});

describe("deleteNote", () => {
  it("removes a note and reports whether a row was deleted", () => {
    const note = createNote({ title: "gone" });
    expect(deleteNote(note.id)).toBe(true);
    expect(getNote(note.id)).toBeNull();
    expect(deleteNote(note.id)).toBe(false);
  });
});

describe("validation", () => {
  it("normalizeNoteTitle: trims, allows empty, rejects non-string / over-long", () => {
    expect(normalizeNoteTitle("  hi  ")).toBe("hi");
    expect(normalizeNoteTitle(undefined)).toBe("");
    expect(normalizeNoteTitle(null)).toBe("");
    expect(() => normalizeNoteTitle(42)).toThrow(NoteValidationError);
    expect(() =>
      normalizeNoteTitle("x".repeat(NOTE_TITLE_MAX_LENGTH + 1))
    ).toThrow(/exceeds/);
  });

  it("validateNoteContent: allows empty, rejects non-string / over-long", () => {
    expect(validateNoteContent(undefined)).toBe("");
    expect(() => validateNoteContent(42)).toThrow(NoteValidationError);
    expect(() =>
      validateNoteContent("x".repeat(NOTE_CONTENT_MAX_LENGTH + 1))
    ).toThrow(/exceeds/);
  });

  it("normalizeNotePinned: coerces boolean/0/1, rejects junk", () => {
    expect(normalizeNotePinned(true)).toBe(1);
    expect(normalizeNotePinned(1)).toBe(1);
    expect(normalizeNotePinned(false)).toBe(0);
    expect(normalizeNotePinned(undefined)).toBe(0);
    expect(() => normalizeNotePinned("yes")).toThrow(NoteValidationError);
  });

  it("createNote surfaces a validation error (a bad field writes no row)", () => {
    expect(() => createNote({ title: 42 })).toThrow(NoteValidationError);
    expect(listNotes()).toHaveLength(0);
  });
});
