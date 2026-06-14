import { describe, it, expect, vi } from "vitest";

// B025 regression: the POST /api/sessions/[id]/pr route used to pass
// `--json number,url,state,title` to `gh pr create`. `gh pr create` does NOT
// support --json, so gh exits non-zero ("unknown flag: --json"), execFileAsync
// rejects, and every request returned "Failed to create PR". The fix drops the
// --json args and parses the PR URL from `gh pr create` stdout (mirroring
// lib/pr.ts createPR), via the exported pure helper parsePRCreateOutput.
//
// Importing the route module evaluates its `next/server` + `@/lib/db` imports
// (the latter loads a native sqlite binding), so stub them out — we only want
// to exercise the pure URL parser.
vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: { json: () => ({}) },
}));
vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {},
}));

import { parsePRCreateOutput } from "@/app/api/sessions/[id]/pr/route";

describe("B025 — parsePRCreateOutput (gh pr create prints a URL, not JSON)", () => {
  it("extracts number + url from a plain `gh pr create` URL line", () => {
    const stdout = "https://github.com/acme/widgets/pull/42\n";
    expect(parsePRCreateOutput(stdout)).toEqual({
      url: "https://github.com/acme/widgets/pull/42",
      number: 42,
    });
  });

  it("extracts number + url from a non-github.com (GitHub Enterprise) host", () => {
    // R2 regression: the parser used to hardcode `https://github.com/...`, so on
    // a GitHub Enterprise / custom remote `gh pr create` prints an enterprise
    // URL the regex couldn't match — createPR threw and the route 500'd even
    // though the PR was created. The host-agnostic regex handles any host.
    const stdout = "https://ghe.corp/owner/repo/pull/42\n";
    expect(parsePRCreateOutput(stdout)).toEqual({
      url: "https://ghe.corp/owner/repo/pull/42",
      number: 42,
    });
  });

  it("finds the URL even amid surrounding gh chatter", () => {
    const stdout = [
      "Warning: 3 uncommitted changes",
      "Creating pull request for feature/x into main in acme/widgets",
      "",
      "https://github.com/acme/widgets/pull/1234",
      "",
    ].join("\n");
    expect(parsePRCreateOutput(stdout)).toEqual({
      url: "https://github.com/acme/widgets/pull/1234",
      number: 1234,
    });
  });

  it("returns null when stdout has no PR URL (e.g. an error string)", () => {
    // This is exactly the old failure mode: `gh: unknown flag: --json`.
    expect(parsePRCreateOutput("unknown flag: --json\n")).toBeNull();
    expect(parsePRCreateOutput("")).toBeNull();
  });

  it("does NOT parse JSON — proving the --json contract was wrong", () => {
    // The old code did JSON.parse(stdout) expecting {number,url,state,title}.
    // Real `gh pr create` output is a bare URL, which JSON.parse would reject;
    // the new parser handles it correctly instead.
    const ghOutput = "https://github.com/owner/repo/pull/7\n";
    expect(() => JSON.parse(ghOutput)).toThrow();
    expect(parsePRCreateOutput(ghOutput)?.number).toBe(7);
  });
});
