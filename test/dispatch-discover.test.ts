import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { discoverGitRepos, defaultScanRoots } from "../lib/dispatch/discover";

describe("discoverGitRepos", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "stoa-discover-"));
    // repoA: a normal clone (.git directory)
    await fs.mkdir(path.join(root, "repoA", ".git"), { recursive: true });
    // repoB: a linked worktree (.git file)
    await fs.mkdir(path.join(root, "repoB"), { recursive: true });
    await fs.writeFile(path.join(root, "repoB", ".git"), "gitdir: /elsewhere");
    // plain: a directory that is not a git checkout
    await fs.mkdir(path.join(root, "plain"), { recursive: true });
    // a top-level file (must be ignored — not a directory)
    await fs.writeFile(path.join(root, "afile.txt"), "x");
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("finds subdirs with a .git dir or file; ignores non-repos and files", async () => {
    const repos = await discoverGitRepos([root]);
    expect(repos.map((r) => r.name)).toEqual(["repoA", "repoB"]);
    expect(repos.every((r) => path.isAbsolute(r.path))).toBe(true);
  });

  it("skips missing / unreadable roots", async () => {
    const repos = await discoverGitRepos([path.join(root, "does-not-exist")]);
    expect(repos).toEqual([]);
  });

  it("de-dupes across overlapping roots", async () => {
    const repos = await discoverGitRepos([root, root]);
    expect(repos.map((r) => r.name)).toEqual(["repoA", "repoB"]);
  });

  it("respects maxPerRoot", async () => {
    const repos = await discoverGitRepos([root], { maxPerRoot: 1 });
    expect(repos.length).toBe(1);
  });
});

describe("defaultScanRoots", () => {
  it("uses each project's parent dir, deduped, ignoring ~ and blank", () => {
    const roots = defaultScanRoots([
      "/home/me/dev/app1",
      "/home/me/dev/app2",
      "/home/me/other/app3",
      "~",
      "",
    ]);
    expect(roots).toContain(path.dirname("/home/me/dev/app1"));
    expect(roots).toContain(path.dirname("/home/me/other/app3"));
    // /home/me/dev appears once despite two projects under it.
    expect(roots.length).toBe(2);
  });

  it("never derives a root from the home dir or a filesystem root", () => {
    // "~/" expands to the home dir; "/" is a filesystem root. Neither should
    // produce a scan root (that would enumerate the whole machine).
    expect(defaultScanRoots(["~/"])).toEqual([]);
    expect(defaultScanRoots(["/"])).toEqual([]);
  });

  it("includes STOA_SCAN_ROOTS (comma / semicolon separated)", () => {
    const prev = process.env.STOA_SCAN_ROOTS;
    process.env.STOA_SCAN_ROOTS = "/extra/one;/extra/two";
    try {
      const roots = defaultScanRoots([]);
      expect(roots).toContain("/extra/one");
      expect(roots).toContain("/extra/two");
    } finally {
      if (prev === undefined) delete process.env.STOA_SCAN_ROOTS;
      else process.env.STOA_SCAN_ROOTS = prev;
    }
  });
});
