import { describe, it, expect } from "vitest";
import {
  extractFileLineLinks,
  isAbsoluteScreenPath,
  resolveLinkTarget,
} from "../lib/terminal-links";

// #23 — the pure extractor behind the terminal's clickable file:line links.
// The xterm link provider trusts these offsets verbatim (1-based columns are
// derived from start/end), so every case asserts the exact matched slice too.

const one = (text: string) => {
  const links = extractFileLineLinks(text);
  expect(links).toHaveLength(1);
  return links[0];
};

describe("extractFileLineLinks — colon form", () => {
  it("matches a POSIX relative path (tsc/eslint style)", () => {
    const l = one("lib/foo.ts:12 - error TS2322");
    expect(l).toMatchObject({ path: "lib/foo.ts", line: 12 });
    expect("lib/foo.ts:12".slice(0, l.end - l.start)).toBe("lib/foo.ts:12");
    expect(l.start).toBe(0);
  });

  it("matches path:line:col and reports the LINE (vitest/node style)", () => {
    const l = one("  at test/foo.test.ts:42:11");
    expect(l).toMatchObject({ path: "test/foo.test.ts", line: 42 });
  });

  it("matches a Windows drive path with backslashes", () => {
    const l = one("C:\\repo\\lib\\x.ts:34");
    expect(l).toMatchObject({ path: "C:\\repo\\lib\\x.ts", line: 34 });
  });

  it("matches a Windows drive path with forward slashes + col", () => {
    const l = one("error in C:/repo/x.tsx:7:2");
    expect(l).toMatchObject({ path: "C:/repo/x.tsx", line: 7 });
  });

  it("matches ./ and .\\ relative prefixes", () => {
    expect(one("./rel/y.js:3")).toMatchObject({ path: "./rel/y.js", line: 3 });
    expect(one(".\\win\\rel.ts:9")).toMatchObject({
      path: ".\\win\\rel.ts",
      line: 9,
    });
  });

  it("matches a POSIX absolute path", () => {
    const l = one("FAIL /home/user/app/src/a.py:101");
    expect(l).toMatchObject({ path: "/home/user/app/src/a.py", line: 101 });
  });

  it("matches a bare filename", () => {
    expect(one("server.ts:1005")).toMatchObject({
      path: "server.ts",
      line: 1005,
    });
  });

  it("matches a multi-dot filename to the REAL extension", () => {
    const l = one("test/budget-park.test.ts:17");
    expect(l).toMatchObject({ path: "test/budget-park.test.ts", line: 17 });
  });

  it("matches inside node-style parenthesized stack frames", () => {
    const l = one("    at run (C:\\repo\\dist\\main.js:10:5)");
    expect(l).toMatchObject({ path: "C:\\repo\\dist\\main.js", line: 10 });
  });
});

describe("extractFileLineLinks — paren form (tsc on Windows, MSVC)", () => {
  it("matches path(line,col)", () => {
    const l = one("lib/a.ts(12,5): error TS2345");
    expect(l).toMatchObject({ path: "lib/a.ts", line: 12 });
  });

  it("matches path(line)", () => {
    const l = one("a.test.ts(8)");
    expect(l).toMatchObject({ path: "a.test.ts", line: 8 });
  });
});

describe("extractFileLineLinks — multiple links + offsets", () => {
  it("extracts every hit on the line, left to right, with exact offsets", () => {
    const text = "a/b.ts:1 then c/d.tsx:22:3 and e.py(9,1)";
    const links = extractFileLineLinks(text);
    expect(links.map((l) => [l.path, l.line])).toEqual([
      ["a/b.ts", 1],
      ["c/d.tsx", 22],
      ["e.py", 9],
    ]);
    for (const l of links) {
      // The clickable slice must round-trip exactly (xterm range contract).
      expect(text.slice(l.start, l.end)).toContain(l.path);
    }
    expect(text.slice(links[1].start, links[1].end)).toBe("c/d.tsx:22:3");
  });
});

describe("extractFileLineLinks — rejections (conservative by design)", () => {
  it.each([
    ["timestamps", "12:30:45"],
    ["version-ish tokens", "node v1.2.3:4 something"],
    ["a URL", "see https://example.com/a.ts:12 for docs"],
    ["a file URL", "file:///c/a.ts:12"],
    ["no line number", "just lib/foo.ts here"],
    ["a bare drive letter", "C: is the drive"],
    ["non-numeric suffix", "foo.ts:bar"],
    ["line zero", "foo.ts:0"],
    ["no extension", "Makefile:12"],
    ["empty input", ""],
  ])("rejects %s", (_name, text) => {
    expect(extractFileLineLinks(text)).toEqual([]);
  });

  it("skips pathologically long lines outright", () => {
    expect(extractFileLineLinks("a.ts:1 " + "x".repeat(5000))).toEqual([]);
  });
});

describe("isAbsoluteScreenPath", () => {
  it("recognizes drive, POSIX, and UNC-style absolutes", () => {
    expect(isAbsoluteScreenPath("C:\\repo\\a.ts")).toBe(true);
    expect(isAbsoluteScreenPath("C:/repo/a.ts")).toBe(true);
    expect(isAbsoluteScreenPath("/home/user/a.ts")).toBe(true);
    expect(isAbsoluteScreenPath("\\\\server\\share\\a.ts")).toBe(true);
  });

  it("rejects relative shapes", () => {
    expect(isAbsoluteScreenPath("lib/a.ts")).toBe(false);
    expect(isAbsoluteScreenPath("./lib/a.ts")).toBe(false);
    expect(isAbsoluteScreenPath(".\\lib\\a.ts")).toBe(false);
  });
});

describe("resolveLinkTarget", () => {
  it("passes absolute paths through untouched", () => {
    expect(resolveLinkTarget("C:\\repo\\a.ts", "D:\\other")).toBe(
      "C:\\repo\\a.ts"
    );
    expect(resolveLinkTarget("/abs/a.ts", "/cwd")).toBe("/abs/a.ts");
  });

  it("joins relative paths onto the session cwd (separator from the base)", () => {
    expect(resolveLinkTarget("lib/a.ts", "C:\\repo")).toBe(
      "C:\\repo\\lib\\a.ts"
    );
    expect(resolveLinkTarget("./lib/a.ts", "/home/u/repo")).toBe(
      "/home/u/repo/lib/a.ts"
    );
  });

  it("returns the path as written when there is no cwd", () => {
    expect(resolveLinkTarget("lib/a.ts", null)).toBe("lib/a.ts");
    expect(resolveLinkTarget("lib/a.ts", "")).toBe("lib/a.ts");
  });
});
