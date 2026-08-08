import { describe, it, expect } from "vitest";
import { parseDeepLink, sessionDeepLinkPath } from "../lib/session-deep-link";

describe("parseDeepLink", () => {
  it("parses ?session=<id> into an open-session action", () => {
    expect(parseDeepLink("?session=abc-123")).toEqual({
      action: "open-session",
      sessionId: "abc-123",
    });
  });

  it("parses a session id without the leading ?", () => {
    expect(parseDeepLink("session=abc-123")).toEqual({
      action: "open-session",
      sessionId: "abc-123",
    });
  });

  it("accepts UUID-shaped session ids", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(parseDeepLink(`?session=${uuid}`)).toEqual({
      action: "open-session",
      sessionId: uuid,
    });
  });

  it("accepts session ids with underscores and dashes", () => {
    expect(parseDeepLink("?session=claude-my_session-1")).toEqual({
      action: "open-session",
      sessionId: "claude-my_session-1",
    });
  });

  it("rejects a session id with path separators", () => {
    expect(parseDeepLink("?session=../etc/passwd")).toBeNull();
    expect(parseDeepLink("?session=a/b")).toBeNull();
    expect(parseDeepLink("?session=a\\b")).toBeNull();
  });

  it("rejects a session id with shell metacharacters", () => {
    expect(parseDeepLink("?session=a;rm -rf /")).toBeNull();
    expect(parseDeepLink("?session=a$(cmd)")).toBeNull();
    expect(parseDeepLink("?session=a|b")).toBeNull();
    expect(parseDeepLink("?session=a b")).toBeNull();
  });

  it("rejects an oversized session id", () => {
    const long = "a".repeat(129);
    expect(parseDeepLink(`?session=${long}`)).toBeNull();
  });

  it("falls back to parseAppAction when no ?session= is present", () => {
    expect(parseDeepLink("?action=board")).toEqual({ action: "board" });
    expect(parseDeepLink("?action=ask")).toEqual({ action: "ask" });
    expect(parseDeepLink("?action=new-session&prompt=hi")).toEqual({
      action: "new-session",
      prompt: "hi",
    });
  });

  it("returns null for an empty or unrecognized query", () => {
    expect(parseDeepLink("")).toBeNull();
    expect(parseDeepLink("?foo=bar")).toBeNull();
    expect(parseDeepLink("?action=unknown")).toBeNull();
  });

  it("session deep link takes precedence over action when both present", () => {
    expect(parseDeepLink("?action=board&session=abc")).toEqual({
      action: "open-session",
      sessionId: "abc",
    });
  });
});

describe("sessionDeepLinkPath", () => {
  it("builds the relative deep-link path", () => {
    expect(sessionDeepLinkPath("abc-123")).toBe("/?session=abc-123");
  });

  it("URL-encodes special characters in the id", () => {
    // Though invalid session ids won't survive parseDeepLink, the path builder
    // is still defensive: it encodes so the URL stays well-formed.
    expect(sessionDeepLinkPath("a b")).toBe("/?session=a%20b");
  });
});
