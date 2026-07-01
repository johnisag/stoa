/**
 * Manifest shortcuts + Web Share Target intake (#17) — the pure core.
 *
 * Two inbound surfaces, one tiny grammar:
 *   - App shortcuts (long-press the installed icon) launch `/?action=<id>`;
 *   - The OS share sheet POSTs title/text/url to `/share` (see app/share/route.ts),
 *     which composes a prompt and 303-redirects to `/?action=new-session&prompt=…`.
 * HomeContent reads the query once on mount, dispatches to the existing handlers
 * (New Session dialog / addViewTab), then strips the params so a reload can't
 * re-fire the action.
 *
 * Everything here is PURE (string in → decision out) so the grammar, the prompt
 * composition, and the clamping are unit-tested without a browser. Client-safe:
 * zero imports.
 */

/** The actions a home-screen shortcut (or the share redirect) may trigger. */
export const APP_ACTIONS = [
  "new-session",
  "board",
  "ask",
  "live-wall",
] as const;
export type AppAction = (typeof APP_ACTIONS)[number];

export interface ParsedAppAction {
  action: AppAction;
  /** Present only for new-session: the seeded initial prompt (shared text). */
  prompt?: string;
}

/**
 * Shared text is seeded into a terminal prompt, so keep it a sane size — a
 * multi-page share would otherwise blow past shell line limits. Clamped, not
 * rejected (the head of a long article is still useful context).
 */
export const MAX_SHARE_PROMPT_CHARS = 4000;

/**
 * Parse `window.location.search` (or any query string) into an app action, or
 * null when there is none / it's unknown. Unknown actions are DROPPED, not
 * guessed — a stale or mistyped shortcut must degrade to a plain app open.
 */
export function parseAppAction(search: string): ParsedAppAction | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(
      search.startsWith("?") ? search.slice(1) : search
    );
  } catch {
    return null;
  }
  const raw = params.get("action");
  if (!raw || !(APP_ACTIONS as readonly string[]).includes(raw)) return null;
  const action = raw as AppAction;
  if (action !== "new-session") return { action };
  const prompt = (params.get("prompt") || "").trim();
  return prompt
    ? { action, prompt: prompt.slice(0, MAX_SHARE_PROMPT_CHARS) }
    : { action };
}

/**
 * Compose a session prompt from a share payload (title/text/url — all optional,
 * any subset). Layout: title line, body text, then the URL on its own line (the
 * common "share an article" shape reads naturally to an agent). Null when the
 * share carried nothing usable.
 */
export function buildSharePrompt(payload: {
  title?: string | null;
  text?: string | null;
  url?: string | null;
}): string | null {
  const parts = [payload.title, payload.text, payload.url]
    .map((s) => (s == null ? "" : String(s).trim()))
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts.join("\n").slice(0, MAX_SHARE_PROMPT_CHARS);
}

/**
 * The in-app path the /share endpoint redirects to. The prompt riding as a
 * query param keeps the flow stateless (no server-side stash to expire); the
 * mount reader strips it from the URL immediately after seeding the dialog.
 */
export function shareRedirectPath(prompt: string | null): string {
  if (!prompt) return "/?action=new-session";
  return `/?action=new-session&prompt=${encodeURIComponent(prompt)}`;
}
