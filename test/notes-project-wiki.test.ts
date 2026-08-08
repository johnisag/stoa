import { describe, it, expect } from "vitest";
import {
  normalizeNoteTitle,
  normalizeNotePinned,
  validateNoteContent,
  NoteValidationError,
} from "../lib/notes";

describe("normalizeNoteTitle", () => {
  it("trims a valid title", () => {
    expect(normalizeNoteTitle("  API Contract  ")).toBe("API Contract");
  });

  it("returns empty string for null/undefined", () => {
    expect(normalizeNoteTitle(null)).toBe("");
    expect(normalizeNoteTitle(undefined)).toBe("");
  });

  it("throws for non-string", () => {
    expect(() => normalizeNoteTitle(42)).toThrow(NoteValidationError);
  });

  it("throws when too long", () => {
    expect(() => normalizeNoteTitle("a".repeat(257))).toThrow(
      NoteValidationError
    );
  });
});

describe("validateNoteContent", () => {
  it("returns content as-is", () => {
    expect(validateNoteContent("# Title\nbody")).toBe("# Title\nbody");
  });

  it("returns empty string for null/undefined", () => {
    expect(validateNoteContent(null)).toBe("");
    expect(validateNoteContent(undefined)).toBe("");
  });

  it("throws when too long", () => {
    expect(() => validateNoteContent("x".repeat(200_001))).toThrow(
      NoteValidationError
    );
  });
});

describe("normalizeNotePinned", () => {
  it("accepts true/1 and false/0/null", () => {
    expect(normalizeNotePinned(true)).toBe(1);
    expect(normalizeNotePinned(1)).toBe(1);
    expect(normalizeNotePinned(false)).toBe(0);
    expect(normalizeNotePinned(0)).toBe(0);
    expect(normalizeNotePinned(null)).toBe(0);
  });

  it("rejects other types", () => {
    expect(() => normalizeNotePinned("yes")).toThrow(NoteValidationError);
    expect(() => normalizeNotePinned(2)).toThrow(NoteValidationError);
  });
});
