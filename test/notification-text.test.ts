/**
 * Regression lock for notification-text sanitization. Session names are
 * untrusted (user/agent-set, sometimes derived from a captured terminal line);
 * a name carrying ANSI codes or box-drawing borders rendered a Windows toast as
 * "strange cut vertical lines" with no readable text. sanitizeNotificationText
 * must strip those while preserving legitimate international names.
 *
 * Control/escape bytes are built via fromCharCode — literal control bytes don't
 * survive a source-file round-trip, and this also makes each case self-documenting.
 */
import { describe, it, expect } from "vitest";
import { sanitizeNotificationText } from "@/lib/notification-text";

const ESC = String.fromCharCode(0x1b);
const cc = (n: number) => String.fromCharCode(n);

describe("sanitizeNotificationText", () => {
  it("passes clean ASCII through unchanged", () => {
    expect(sanitizeNotificationText("my-session")).toBe("my-session");
  });

  it("strips ANSI CSI color codes (the common case)", () => {
    expect(sanitizeNotificationText(`${ESC}[32mbuild${ESC}[0m`)).toBe("build");
  });

  it("strips ANSI OSC (window-title) sequences terminated by BEL", () => {
    expect(sanitizeNotificationText(`${ESC}]0;title${cc(0x07)}task`)).toBe(
      "task"
    );
  });

  it("strips a lone/other ESC sequence (ESC c = RIS)", () => {
    expect(sanitizeNotificationText(`${ESC}chello`)).toBe("hello");
  });

  it("handles a bare ESC at end of string", () => {
    expect(sanitizeNotificationText(`hello${ESC}`)).toBe("hello");
  });

  it("does not leak a CSI that follows a stray ESC (ESC ESC [0m)", () => {
    expect(sanitizeNotificationText(`${ESC}${ESC}[0mhi`)).toBe("hi");
  });

  it("handles an unterminated OSC (no BEL) at end of string", () => {
    expect(sanitizeNotificationText(`${ESC}]0;title-no-bel`)).toBe("");
  });

  it("strips box-drawing borders (the reported vertical lines)", () => {
    const input = `task ${cc(0x2502)} running ${cc(0x2500)}`;
    expect(sanitizeNotificationText(input)).toBe("task running");
  });

  it("replaces control chars with spaces and collapses them", () => {
    const input = `a${cc(0x00)}b${cc(0x09)}c`;
    expect(sanitizeNotificationText(input)).toBe("a b c");
  });

  it("removes zero-width and replacement chars without leaving a gap", () => {
    const input = `na${cc(0x200b)}me${cc(0xfffd)}`;
    expect(sanitizeNotificationText(input)).toBe("name");
  });

  it("keeps legitimate printable Unicode (accents, CJK, emoji)", () => {
    const input = `café 日本語 ${String.fromCodePoint(0x1f680)}`;
    expect(sanitizeNotificationText(input)).toBe(input);
  });

  it("strips bidi overrides and line/paragraph separators", () => {
    // U+202E (RTL override) reverses following text; U+2028 renders as a break.
    const input = `safe${cc(0x202e)}evil${cc(0x2028)}name`;
    expect(sanitizeNotificationText(input)).toBe("safeevil name");
  });

  it("does not tear an astral char at the maxLen boundary", () => {
    const rocket = String.fromCodePoint(0x1f680);
    const out = sanitizeNotificationText("x".repeat(79) + rocket, {
      maxLen: 80,
    });
    expect(out).toBe("x".repeat(79) + rocket); // intact, no lone surrogate
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeNotificationText("  a   b  ")).toBe("a b");
  });

  it("returns the fallback for all-whitespace input", () => {
    expect(
      sanitizeNotificationText(`  ${cc(0x09)} `, { fallback: "Session" })
    ).toBe("Session");
  });

  it("caps length to maxLen", () => {
    expect(sanitizeNotificationText("x".repeat(200), { maxLen: 10 })).toBe(
      "x".repeat(10)
    );
  });

  it("returns the fallback for empty / all-garbage / non-string input", () => {
    expect(sanitizeNotificationText("", { fallback: "Session" })).toBe(
      "Session"
    );
    expect(
      sanitizeNotificationText(`${cc(0x2502)}${cc(0x07)}`, {
        fallback: "Session",
      })
    ).toBe("Session");
    // @ts-expect-error — exercising the non-string runtime guard
    expect(sanitizeNotificationText(null, { fallback: "Session" })).toBe(
      "Session"
    );
  });

  it("defaults the fallback to an empty string", () => {
    expect(sanitizeNotificationText(cc(0x2502))).toBe("");
  });

  it("realistic: a name that is actually a captured prompt-box line", () => {
    const leaked = `${cc(0x250c)}${cc(0x2500).repeat(3)} Do you want to proceed? ${cc(0x2502)}`;
    expect(sanitizeNotificationText(leaked)).toBe("Do you want to proceed?");
  });
});
