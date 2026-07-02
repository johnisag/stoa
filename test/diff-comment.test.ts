import { describe, it, expect } from "vitest";
import {
  formatReviewComment,
  formatPreviewComment,
  normalizeLocator,
  describeLocator,
} from "@/lib/diff-comment";

describe("formatReviewComment (#1-A diff review note)", () => {
  it("includes the file, line, quoted line, and the trimmed comment", () => {
    const m = formatReviewComment(
      "src/app.ts",
      42,
      "const x = 1;",
      "  rename x to count  "
    );
    expect(m).toMatch(/^\[Stoa\] Review note on/);
    expect(m).toContain("src/app.ts (line 42)");
    expect(m).toContain("> const x = 1;");
    expect(m.endsWith("rename x to count")).toBe(true); // comment trimmed
  });

  it("omits the line number when null or 0", () => {
    const a = formatReviewComment("src/app.ts", null, "x", "c");
    expect(a).toContain("on src/app.ts:");
    expect(a).not.toContain("(line");
    expect(formatReviewComment("src/app.ts", 0, "x", "c")).not.toContain(
      "(line"
    );
  });

  it("omits the quote block when the line content is blank", () => {
    expect(formatReviewComment("f", 1, "   ", "c")).not.toContain(">");
  });

  it("strips control bytes (ESC / bracketed-paste escape) but keeps newlines", () => {
    // A line content with an embedded bracketed-paste-end + ESC must not survive
    // into the keystroke channel.
    const m = formatReviewComment(
      "f",
      1,
      "code\x1b[201~rm -rf",
      "line one\ntwo\x1b[A"
    );
    expect(m).not.toContain("\x1b");
    expect(m).toContain("code[201~rm -rf"); // ESC removed, rest inert text
    expect(m).toContain("line one\ntwo[A"); // newline kept, ESC removed
  });
});

describe("normalizeLocator (#28 preview picker)", () => {
  it("lowercases the tag and passes stable handles through", () => {
    const loc = normalizeLocator({
      tag: "BUTTON",
      id: "submit-btn",
      testId: "login-submit",
      text: "Sign in",
      domPath: "main > form.login > button",
      url: "http://localhost:3000/login",
    });
    expect(loc.tag).toBe("button");
    expect(loc.id).toBe("submit-btn");
    expect(loc.testId).toBe("login-submit");
    expect(loc.text).toBe("Sign in");
    expect(loc.domPath).toBe("main > form.login > button");
    expect(loc.url).toBe("http://localhost:3000/login");
  });

  it("falls back to the 'element' tag and nulls empty fields", () => {
    const loc = normalizeLocator({ tag: "   ", id: "", text: "   " });
    expect(loc.tag).toBe("element");
    expect(loc.id).toBeNull();
    expect(loc.text).toBeNull();
    expect(loc.domPath).toBeNull();
  });

  it("collapses whitespace/newlines in the text snippet to one line", () => {
    const loc = normalizeLocator({
      tag: "p",
      text: "  hello\n  there\tworld  ",
    });
    expect(loc.text).toBe("hello there world");
  });

  it("strips control bytes (ESC / bracketed-paste) from every field", () => {
    const loc = normalizeLocator({
      tag: "a",
      id: "x\x1b[201~y",
      text: "click\x1bhere",
      domPath: "div\x07> a",
    });
    expect(JSON.stringify(loc)).not.toContain("\x1b");
    expect(loc.id).toBe("x[201~y");
    expect(loc.text).toBe("clickhere");
    expect(loc.domPath).toBe("div> a");
  });

  it("caps overlong fields with an ellipsis", () => {
    const long = "a".repeat(500);
    const loc = normalizeLocator({ tag: "p", text: long, domPath: long });
    expect(loc.text!.length).toBeLessThan(long.length);
    expect(loc.text!.endsWith("…")).toBe(true);
    expect(loc.domPath!.endsWith("…")).toBe(true);
  });
});

describe("describeLocator (#28)", () => {
  it("prefers data-testid, then id, then text, then bare tag", () => {
    expect(
      describeLocator(normalizeLocator({ tag: "button", testId: "go" }))
    ).toBe('<button data-testid="go">');
    expect(describeLocator(normalizeLocator({ tag: "button", id: "go" }))).toBe(
      '<button id="go">'
    );
    expect(describeLocator(normalizeLocator({ tag: "a", text: "Home" }))).toBe(
      '<a> "Home"'
    );
    expect(describeLocator(normalizeLocator({ tag: "div" }))).toBe("<div>");
  });
});

describe("formatPreviewComment (#28 click-to-comment message)", () => {
  it("builds the exact structured message for a fully-specified locator", () => {
    const m = formatPreviewComment({
      locator: normalizeLocator({
        tag: "button",
        testId: "checkout",
        domPath: "main > form > button",
        text: "Buy now",
        url: "http://localhost:3000/cart",
      }),
      note: "  make this button green  ",
    });
    expect(m).toBe(
      [
        '[Stoa] UI note on <button data-testid="checkout">:',
        "page: http://localhost:3000/cart",
        "path: main > form > button",
        'text: "Buy now"',
        "",
        "make this button green",
      ].join("\n")
    );
  });

  it("does not duplicate the text line when text is the only handle", () => {
    const m = formatPreviewComment({
      locator: normalizeLocator({ tag: "a", text: "Home" }),
      note: "link is broken",
    });
    // text already surfaced in the <a> "Home" header — no separate text: line
    expect(m).toContain('[Stoa] UI note on <a> "Home":');
    expect(m).not.toContain('text: "Home"');
    expect(m.endsWith("link is broken")).toBe(true);
  });

  it("omits page/path lines when absent", () => {
    const m = formatPreviewComment({
      locator: normalizeLocator({ tag: "div", id: "root" }),
      note: "n",
    });
    expect(m).not.toContain("page:");
    expect(m).not.toContain("path:");
  });

  it("strips control bytes from the note (keeps newlines)", () => {
    const m = formatPreviewComment({
      locator: normalizeLocator({ tag: "p" }),
      note: "line one\ntwo\x1b[A three\x07",
    });
    expect(m).not.toContain("\x1b");
    expect(m).toContain("line one\ntwo[A three");
  });
});
