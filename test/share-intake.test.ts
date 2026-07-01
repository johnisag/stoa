import { describe, it, expect } from "vitest";
import {
  APP_ACTIONS,
  parseAppAction,
  buildSharePrompt,
  shareRedirectPath,
  MAX_SHARE_PROMPT_CHARS,
} from "@/lib/share-intake";

describe("parseAppAction (#17 — shortcut/share deep-link grammar)", () => {
  it("parses each known action, with or without a leading '?'", () => {
    for (const action of APP_ACTIONS) {
      expect(parseAppAction(`?action=${action}`)).toEqual({ action });
      expect(parseAppAction(`action=${action}`)).toEqual({ action });
    }
  });

  it("returns null for no action / unknown action / empty search", () => {
    expect(parseAppAction("")).toBeNull();
    expect(parseAppAction("?foo=bar")).toBeNull();
    expect(parseAppAction("?action=hack-the-planet")).toBeNull();
    expect(parseAppAction("?action=")).toBeNull();
  });

  it("carries a prompt ONLY for new-session, trimmed and decoded", () => {
    expect(
      parseAppAction(
        `?action=new-session&prompt=${encodeURIComponent(" Fix this bug: https://x/y ")}`
      )
    ).toEqual({ action: "new-session", prompt: "Fix this bug: https://x/y" });
    // a prompt on a non-new-session action is ignored
    expect(parseAppAction("?action=board&prompt=hi")).toEqual({
      action: "board",
    });
    // empty prompt → no prompt key
    expect(parseAppAction("?action=new-session&prompt=")).toEqual({
      action: "new-session",
    });
  });

  it("clamps an oversized prompt to MAX_SHARE_PROMPT_CHARS", () => {
    const big = "x".repeat(MAX_SHARE_PROMPT_CHARS + 500);
    const parsed = parseAppAction(
      `?action=new-session&prompt=${encodeURIComponent(big)}`
    );
    expect(parsed?.prompt).toHaveLength(MAX_SHARE_PROMPT_CHARS);
  });
});

describe("buildSharePrompt (#17 — share payload → seeded prompt)", () => {
  it("joins title, text, and url on their own lines", () => {
    expect(
      buildSharePrompt({
        title: "Cool article",
        text: "Look at this",
        url: "https://example.com/a",
      })
    ).toBe("Cool article\nLook at this\nhttps://example.com/a");
  });

  it("handles any subset (url-only share, text-only share)", () => {
    expect(buildSharePrompt({ url: "https://x" })).toBe("https://x");
    expect(buildSharePrompt({ text: "just text" })).toBe("just text");
  });

  it("returns null for an empty/whitespace-only share", () => {
    expect(buildSharePrompt({})).toBeNull();
    expect(buildSharePrompt({ title: "  ", text: "", url: null })).toBeNull();
  });

  it("clamps the composed prompt", () => {
    const out = buildSharePrompt({
      text: "y".repeat(MAX_SHARE_PROMPT_CHARS * 2),
    });
    expect(out).toHaveLength(MAX_SHARE_PROMPT_CHARS);
  });
});

describe("shareRedirectPath (#17 — /share → app shell)", () => {
  it("routes a prompt into /?action=new-session&prompt=… (encoded)", () => {
    const path = shareRedirectPath("fix this & that?");
    expect(path).toBe(
      `/?action=new-session&prompt=${encodeURIComponent("fix this & that?")}`
    );
  });

  it("round-trips through parseAppAction (encode → parse)", () => {
    const prompt = "Review https://ex.com/pr?id=1&x=2 — thanks!";
    const path = shareRedirectPath(prompt);
    const search = path.slice(path.indexOf("?"));
    expect(parseAppAction(search)).toEqual({
      action: "new-session",
      prompt,
    });
  });

  it("a null prompt opens the dialog empty", () => {
    expect(shareRedirectPath(null)).toBe("/?action=new-session");
  });
});
