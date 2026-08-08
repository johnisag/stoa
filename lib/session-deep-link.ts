/** Pure helpers for session deep links (?session=<id>). Extends share-intake. */

import { parseAppAction, type ParsedAppAction } from "./share-intake";

/** A session deep link: ?session=<id> — opens the app focused on a session. */
export interface SessionDeepLink {
  action: "open-session";
  sessionId: string;
}

export type ParsedDeepLink = ParsedAppAction | SessionDeepLink | null;

/**
 * Parse a query string into either an existing app action (new-session/board/ask/live-wall),
 * a session deep link (?session=<id>), or null when there's nothing actionable.
 * Client-safe; zero imports beyond share-intake.
 */
export function parseDeepLink(search: string): ParsedDeepLink {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(
      search.startsWith("?") ? search.slice(1) : search
    );
  } catch {
    return null;
  }
  // Session deep link takes precedence — it's the most specific intent.
  const sid = params.get("session");
  if (sid) {
    // Validate: non-empty, alphanumeric + dash (Stoa session ids are UUIDs or
    // prefixed slugs). Reject anything with a path separator / shell metachar.
    if (/^[A-Za-z0-9_-]+$/.test(sid) && sid.length <= 128) {
      return { action: "open-session", sessionId: sid };
    }
    return null;
  }
  return parseAppAction(search);
}

/** Build a session deep-link URL relative to the current origin. Pure → testable. */
export function sessionDeepLinkPath(sessionId: string): string {
  return `/?session=${encodeURIComponent(sessionId)}`;
}
