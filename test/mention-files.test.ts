import { describe, it, expect } from "vitest";
import {
  detectMention,
  mentionCandidatesFromTree,
  filterMentionFiles,
  applyMention,
} from "../lib/mention-files";
import type { FileNode } from "../lib/file-utils";

// #24 — the pure logic behind @-mention file autocomplete in the send bar.

describe("detectMention", () => {
  it("detects an @ at the start of the text", () => {
    expect(detectMention("@bud", 4)).toEqual({ start: 0, query: "bud" });
  });

  it("detects an @ after whitespace mid-prompt", () => {
    const text = "please fix @ses";
    expect(detectMention(text, text.length)).toEqual({
      start: 11,
      query: "ses",
    });
  });

  it("detects a bare @ (empty query) right after typing it", () => {
    expect(detectMention("look at @", 9)).toEqual({ start: 8, query: "" });
  });

  it("detects after a newline (multi-line prompts)", () => {
    const text = "line one\n@fo";
    expect(detectMention(text, text.length)).toEqual({ start: 9, query: "fo" });
  });

  it("rejects a mid-word @ (emails, scoped packages, foo@1.2)", () => {
    const email = "mail me a@b.com";
    expect(detectMention(email, email.length)).toBeNull();
    const pkg = "bump foo@1.2";
    expect(detectMention(pkg, pkg.length)).toBeNull();
  });

  it("closes once whitespace ends the token", () => {
    const text = "@lib done";
    expect(detectMention(text, text.length)).toBeNull();
    // …but the caret INSIDE the token still counts.
    expect(detectMention(text, 4)).toEqual({ start: 0, query: "lib" });
  });

  it("rejects a second @ inside the token and caret at position 0", () => {
    expect(detectMention("@a@b", 4)).toBeNull();
    expect(detectMention("@abc", 0)).toBeNull();
  });

  it("gives up past the query-length cap (a runaway token is not a mention)", () => {
    const text = "@" + "x".repeat(80);
    expect(detectMention(text, text.length)).toBeNull();
  });

  it("handles an out-of-range caret defensively", () => {
    expect(detectMention("@a", 99)).toBeNull();
  });
});

describe("mentionCandidatesFromTree", () => {
  const tree: FileNode[] = [
    {
      name: "lib",
      path: "C:\\repo\\lib",
      type: "directory",
      children: [
        { name: "budget.ts", path: "C:\\repo\\lib\\budget.ts", type: "file" },
      ],
    },
    { name: "server.ts", path: "C:\\repo\\server.ts", type: "file" },
  ];

  it("flattens to files only, with forward-slashed relative paths", () => {
    expect(mentionCandidatesFromTree(tree, "C:\\repo")).toEqual([
      { name: "budget.ts", rel: "lib/budget.ts" },
      { name: "server.ts", rel: "server.ts" },
    ]);
  });

  it("works with POSIX bases too", () => {
    const posix: FileNode[] = [
      { name: "a.ts", path: "/home/u/repo/src/a.ts", type: "file" },
    ];
    expect(mentionCandidatesFromTree(posix, "/home/u/repo")).toEqual([
      { name: "a.ts", rel: "src/a.ts" },
    ]);
  });
});

describe("filterMentionFiles", () => {
  const files = [
    { name: "budget.ts", rel: "lib/budget.ts" },
    { name: "budget-park.ts", rel: "lib/budget-park.ts" },
    { name: "index.ts", rel: "components/Budget/index.ts" },
    { name: "readme.md", rel: "readme.md" },
  ];

  it("empty query lists candidates alphabetically by path, capped", () => {
    const out = filterMentionFiles(files, "", 2);
    expect(out.map((f) => f.rel)).toEqual([
      "components/Budget/index.ts",
      "lib/budget-park.ts",
    ]);
  });

  it("ranks a NAME match above a path-only match", () => {
    const out = filterMentionFiles(files, "budget");
    expect(out[0].name.startsWith("budget")).toBe(true);
    expect(out.map((f) => f.rel)).toContain("components/Budget/index.ts");
    expect(out.map((f) => f.rel)).not.toContain("readme.md");
  });

  it("matches through the path when the name alone doesn't", () => {
    const out = filterMentionFiles(files, "components/index");
    expect(out.map((f) => f.rel)).toEqual(["components/Budget/index.ts"]);
  });

  it("returns [] when nothing matches", () => {
    expect(filterMentionFiles(files, "zzzz")).toEqual([]);
  });

  it("caps the result list", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: `f${i}.ts`,
      rel: `src/f${i}.ts`,
    }));
    expect(filterMentionFiles(many, "f", 8)).toHaveLength(8);
  });
});

describe("applyMention", () => {
  it("replaces the @token with the relative path + trailing space", () => {
    const text = "please fix @bud now";
    // caret right after "@bud" (index 15)
    const out = applyMention(
      text,
      { start: 11, query: "bud" },
      15,
      "lib/budget.ts"
    );
    expect(out.next).toBe("please fix lib/budget.ts  now");
    expect(out.caret).toBe("please fix lib/budget.ts ".length);
  });

  it("quotes a relative path containing whitespace", () => {
    const out = applyMention("@x", { start: 0, query: "x" }, 2, "my docs/a.md");
    expect(out.next).toBe('"my docs/a.md" ');
  });

  it("handles the bare-@ empty-query case", () => {
    const out = applyMention("see @", { start: 4, query: "" }, 5, "a.ts");
    expect(out.next).toBe("see a.ts ");
    expect(out.caret).toBe(9);
  });

  it("strips control chars from a hostile filename (keystroke-injection guard)", () => {
    // POSIX allows raw newlines/ESC in filenames; pasted into the pty those
    // are keystrokes. Built via fromCharCode so no literal control bytes live
    // in this source file.
    const hostile =
      "evil" + String.fromCharCode(10) + String.fromCharCode(27) + "name.ts";
    const out = applyMention("@x", { start: 0, query: "x" }, 2, hostile);
    expect(out.next).toBe("evilname.ts ");
  });
});
