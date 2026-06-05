import { describe, it, expect } from "vitest";
import {
  buildIssueCreateArgs,
  parseCreatedIssueUrl,
} from "../lib/dispatch/create";

describe("buildIssueCreateArgs", () => {
  it("builds non-interactive argv with --repo/--title/--body", () => {
    expect(
      buildIssueCreateArgs({
        repoSlug: "octo/app",
        title: "Fix the thing",
        body: "details",
        labels: [],
      })
    ).toEqual([
      "issue",
      "create",
      "--repo",
      "octo/app",
      "--title",
      "Fix the thing",
      "--body",
      "details",
    ]);
  });

  it("appends a --label flag per non-blank label", () => {
    const args = buildIssueCreateArgs({
      repoSlug: "octo/app",
      title: "t",
      body: "",
      labels: ["bug", "  ", "ready"],
    });
    expect(args.filter((a) => a === "--label")).toHaveLength(2);
    expect(args).toContain("bug");
    expect(args).toContain("ready");
    // blank label dropped
    expect(args).not.toContain("  ");
  });

  it("never produces a shell string — every arg is a discrete token", () => {
    const args = buildIssueCreateArgs({
      repoSlug: "octo/app",
      title: 'a "quoted" title; rm -rf',
      body: "b",
      labels: [],
    });
    // The dangerous title is one argv element, not split/interpreted.
    expect(args).toContain('a "quoted" title; rm -rf');
  });

  it("keeps a title starting with -- as the --title value (no flag injection)", () => {
    const args = buildIssueCreateArgs({
      repoSlug: "octo/app",
      title: "--repo evil/other --label x",
      body: "",
      labels: [],
    });
    // The value sits in the slot right after --title, so gh reads it literally.
    expect(args[4]).toBe("--title");
    expect(args[5]).toBe("--repo evil/other --label x");
  });
});

describe("parseCreatedIssueUrl", () => {
  it("extracts number + url from gh's success output", () => {
    expect(
      parseCreatedIssueUrl("https://github.com/octo/app/issues/42\n")
    ).toEqual({ number: 42, url: "https://github.com/octo/app/issues/42" });
  });

  it("takes the url even with leading gh chatter", () => {
    const out =
      "Creating issue in octo/app\n\nhttps://github.com/octo/app/issues/7";
    expect(parseCreatedIssueUrl(out)).toEqual({
      number: 7,
      url: "https://github.com/octo/app/issues/7",
    });
  });

  it("still finds the url if gh prints a trailing line after it", () => {
    const out = "https://github.com/octo/app/issues/5\nDone.";
    expect(parseCreatedIssueUrl(out)).toEqual({
      number: 5,
      url: "https://github.com/octo/app/issues/5",
    });
  });

  it("returns null when no /issues/<n> url is present", () => {
    expect(parseCreatedIssueUrl("")).toBeNull();
    expect(parseCreatedIssueUrl("something went wrong")).toBeNull();
    expect(
      parseCreatedIssueUrl("https://github.com/octo/app/pull/9")
    ).toBeNull();
  });
});
