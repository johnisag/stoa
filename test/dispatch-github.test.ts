import { describe, it, expect } from "vitest";
import * as path from "path";
import {
  parseGitHubRepos,
  defaultCloneRoot,
  repoDirName,
  prepareGitHubRepo,
} from "../lib/dispatch/github";

describe("parseGitHubRepos", () => {
  it("parses nameWithOwner + defaultBranchRef + isPrivate", () => {
    const json = JSON.stringify([
      {
        nameWithOwner: "octo/app",
        defaultBranchRef: { name: "main" },
        isPrivate: true,
      },
      {
        nameWithOwner: "octo/lib",
        defaultBranchRef: { name: "develop" },
        isPrivate: false,
      },
    ]);
    expect(parseGitHubRepos(json)).toEqual([
      { slug: "octo/app", defaultBranch: "main", isPrivate: true },
      { slug: "octo/lib", defaultBranch: "develop", isPrivate: false },
    ]);
  });

  it("treats a null defaultBranchRef (empty repo) as an empty branch", () => {
    const json = JSON.stringify([
      { nameWithOwner: "octo/empty", defaultBranchRef: null },
    ]);
    expect(parseGitHubRepos(json)).toEqual([
      { slug: "octo/empty", defaultBranch: "", isPrivate: false },
    ]);
  });

  it("drops entries without a nameWithOwner", () => {
    const json = JSON.stringify([
      { defaultBranchRef: { name: "main" } },
      { nameWithOwner: "octo/ok", defaultBranchRef: { name: "main" } },
    ]);
    expect(parseGitHubRepos(json).map((r) => r.slug)).toEqual(["octo/ok"]);
  });

  it("returns [] for non-array or invalid JSON", () => {
    expect(parseGitHubRepos("{}")).toEqual([]);
    expect(parseGitHubRepos("not json")).toEqual([]);
    expect(parseGitHubRepos("")).toEqual([]);
  });
});

describe("defaultCloneRoot", () => {
  it("prefers STOA_CLONE_ROOT when set", () => {
    const prev = process.env.STOA_CLONE_ROOT;
    process.env.STOA_CLONE_ROOT = "/clones";
    try {
      expect(defaultCloneRoot(["/home/me/dev/app"])).toBe("/clones");
    } finally {
      if (prev === undefined) delete process.env.STOA_CLONE_ROOT;
      else process.env.STOA_CLONE_ROOT = prev;
    }
  });

  it("falls back to the first project's parent folder", () => {
    const prev = process.env.STOA_CLONE_ROOT;
    delete process.env.STOA_CLONE_ROOT;
    try {
      const root = defaultCloneRoot(["/home/me/dev/app1"]);
      expect(root).toBe(path.dirname("/home/me/dev/app1"));
    } finally {
      if (prev !== undefined) process.env.STOA_CLONE_ROOT = prev;
    }
  });

  it("returns null when there is no env and no usable project", () => {
    const prev = process.env.STOA_CLONE_ROOT;
    delete process.env.STOA_CLONE_ROOT;
    try {
      expect(defaultCloneRoot([])).toBeNull();
      expect(defaultCloneRoot(["~"])).toBeNull();
    } finally {
      if (prev !== undefined) process.env.STOA_CLONE_ROOT = prev;
    }
  });
});

describe("repoDirName", () => {
  it("takes the repo part of owner/name", () => {
    expect(repoDirName("octo/app")).toBe("app");
    expect(repoDirName("octo/my.cool-repo")).toBe("my.cool-repo");
    expect(repoDirName("noslash")).toBe("noslash");
  });
});

describe("prepareGitHubRepo guard", () => {
  it("rejects a slug whose name would escape the parent dir (before any spawn)", async () => {
    await expect(prepareGitHubRepo("owner/..", "/tmp")).rejects.toThrow(
      /unsafe/i
    );
    await expect(prepareGitHubRepo("owner/.", "/tmp")).rejects.toThrow(
      /unsafe/i
    );
  });
});
