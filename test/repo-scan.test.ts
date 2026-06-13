/**
 * findGitReposUnder — multi-repo discovery. Real filesystem (a tmpdir tree with
 * fake `.git` markers), no git binary: locks depth handling, "a repo is a leaf
 * (don't descend)", and the skip-dirs guard. OS-independent (real fs in tmpdir).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findGitReposUnder } from "@/lib/repo-scan";

let root: string;
const repo = (...p: string[]) => {
  const dir = join(root, ...p);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".git")); // fake `.git` marks it a checkout
};
const plainDir = (...p: string[]) =>
  mkdirSync(join(root, ...p), { recursive: true });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "repo-scan-"));
  // depth-1 repos (the common case: a folder of sibling repos)
  repo("etl-engine");
  repo("gridops-cop");
  // a non-repo group holding a depth-2 repo
  repo("group", "nested-repo");
  // a subdir INSIDE a repo that also has .git — must be ignored (a repo is a leaf)
  repo("etl-engine", "packages", "inner");
  // node_modules is skipped entirely, even though it holds a ".git"
  repo("node_modules", "some-pkg");
  // a plain folder with nothing underneath
  plainDir("plain");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("findGitReposUnder", () => {
  it("finds depth-1 + depth-2 repos, stops at a repo, skips node_modules", async () => {
    const repos = await findGitReposUnder(root, 2);
    expect(repos.map((r) => r.name).sort()).toEqual([
      "etl-engine",
      "gridops-cop",
      "nested-repo",
    ]);
    const depthByName = Object.fromEntries(repos.map((r) => [r.name, r.depth]));
    expect(depthByName["etl-engine"]).toBe(1);
    expect(depthByName["nested-repo"]).toBe(2);
    // The .git inside etl-engine/packages/inner is never visited (etl-engine is a
    // leaf), and node_modules/some-pkg is skipped — neither appears.
    expect(repos.map((r) => r.name)).not.toContain("inner");
    expect(repos.map((r) => r.name)).not.toContain("some-pkg");
  });

  it("maxDepth=1 finds only immediate children", async () => {
    const repos = await findGitReposUnder(root, 1);
    expect(repos.map((r) => r.name).sort()).toEqual([
      "etl-engine",
      "gridops-cop",
    ]);
  });

  it("returns [] for a missing root (never throws)", async () => {
    expect(await findGitReposUnder(join(root, "nope"))).toEqual([]);
  });

  it("respects maxResults", async () => {
    const repos = await findGitReposUnder(root, 2, { maxResults: 1 });
    expect(repos).toHaveLength(1);
  });
});
