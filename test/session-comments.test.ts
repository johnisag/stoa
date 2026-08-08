import { describe, it, expect } from "vitest";
import {
  validateCommentBody,
  normalizeCommentAuthor,
  CommentValidationError,
} from "../lib/session-comments";

describe("validateCommentBody", () => {
  it("trims and returns a valid body", () => {
    expect(validateCommentBody("  hello  ")).toBe("hello");
  });

  it("throws for null/undefined (body is required)", () => {
    expect(() => validateCommentBody(null)).toThrow(CommentValidationError);
    expect(() => validateCommentBody(undefined)).toThrow(
      CommentValidationError
    );
  });

  it("throws for non-string", () => {
    expect(() => validateCommentBody(123)).toThrow(CommentValidationError);
    expect(() => validateCommentBody({})).toThrow(CommentValidationError);
  });

  it("throws for empty or whitespace-only body", () => {
    expect(() => validateCommentBody("")).toThrow(CommentValidationError);
    expect(() => validateCommentBody("   ")).toThrow(CommentValidationError);
  });

  it("throws for body exceeding the cap", () => {
    const long = "a".repeat(10_001);
    expect(() => validateCommentBody(long)).toThrow(CommentValidationError);
  });

  it("accepts a body at exactly the cap", () => {
    const exact = "a".repeat(10_000);
    expect(validateCommentBody(exact)).toBe(exact);
  });
});

describe("normalizeCommentAuthor", () => {
  it("trims a valid author", () => {
    expect(normalizeCommentAuthor("  Alice  ")).toBe("Alice");
  });

  it("returns empty string for null/undefined", () => {
    expect(normalizeCommentAuthor(null)).toBe("");
    expect(normalizeCommentAuthor(undefined)).toBe("");
  });

  it("throws for non-string", () => {
    expect(() => normalizeCommentAuthor(42)).toThrow(CommentValidationError);
  });

  it("throws for author exceeding the cap", () => {
    const long = "a".repeat(121);
    expect(() => normalizeCommentAuthor(long)).toThrow(CommentValidationError);
  });

  it("allows empty author (anonymous)", () => {
    expect(normalizeCommentAuthor("")).toBe("");
  });
});
