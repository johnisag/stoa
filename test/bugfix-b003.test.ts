import { describe, it, expect } from "vitest";

import { buildSearchArgs } from "@/lib/code-search";

// Regression test for B003: caseSensitive and filePattern were destructured
// (with defaults) but never applied to the ripgrep argv — `--ignore-case` was
// hardcoded and `--glob` was never passed, so a case-sensitive or file-scoped
// request was silently ignored. These assertions fail if anyone reverts to the
// hardcoded behavior.

describe("buildSearchArgs honors search options", () => {
  it("defaults to case-insensitive and no glob", () => {
    const args = buildSearchArgs("needle");
    expect(args).toContain("--ignore-case");
    expect(args.some((a) => a.startsWith("--glob"))).toBe(false);
    // option terminator, query, then explicit search dir are the trailing args
    expect(args.slice(-3)).toEqual(["--", "needle", "."]);
  });

  it("drops --ignore-case when caseSensitive is requested", () => {
    const args = buildSearchArgs("Needle", { caseSensitive: true });
    expect(args).not.toContain("--ignore-case");
  });

  it("passes --glob when filePattern is non-default", () => {
    const args = buildSearchArgs("needle", { filePattern: "*.ts" });
    expect(args).toContain("--glob=*.ts");
  });

  it('treats "*" filePattern as the default (no glob)', () => {
    const args = buildSearchArgs("needle", { filePattern: "*" });
    expect(args.some((a) => a.startsWith("--glob"))).toBe(false);
  });

  it("reflects maxResults and contextLines in the argv", () => {
    const args = buildSearchArgs("needle", {
      maxResults: 50,
      contextLines: 4,
    });
    expect(args).toContain(`--max-count=${Math.ceil(50 / 10)}`);
    expect(args).toContain("--context=4");
  });

  it("keeps the query as a discrete trailing argv token (no shell)", () => {
    const evil = "$(rm -rf /); foo";
    const args = buildSearchArgs(evil, { caseSensitive: true });
    // query is verbatim, immediately before the search-dir token, after "--"
    expect(args).toEqual(expect.arrayContaining([evil]));
    expect(args[args.length - 3]).toBe("--");
    expect(args[args.length - 2]).toBe(evil);
    expect(args[args.length - 1]).toBe(".");
  });

  it('preserves a "-l" query as a positional after the "--" terminator', () => {
    // Without the option terminator rg would parse "-l" as the --files-with-matches
    // flag and search for nothing; "--" forces it to be treated as the pattern.
    const args = buildSearchArgs("-l");
    expect(args.slice(-3)).toEqual(["--", "-l", "."]);
    // and the dash query is not present anywhere ahead of the terminator
    expect(args.indexOf("-l")).toBe(args.indexOf("--") + 1);
  });
});
