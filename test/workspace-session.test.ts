/**
 * Client-safe workspace-session helpers: parse the worktree_paths JSON column and
 * map it to the ProjectRepository shape the multi-repo Git panel renders. Pure.
 */
import { describe, it, expect } from "vitest";
import {
  parseWorktreePaths,
  worktreePathsToRepositories,
} from "@/lib/workspace-session";

describe("parseWorktreePaths", () => {
  it("parses a JSON array of paths", () => {
    expect(parseWorktreePaths('["/wt/etl-engine","/wt/gridops-cop"]')).toEqual([
      "/wt/etl-engine",
      "/wt/gridops-cop",
    ]);
  });

  it("returns [] for null/blank/malformed/non-array (never throws)", () => {
    expect(parseWorktreePaths(null)).toEqual([]);
    expect(parseWorktreePaths(undefined)).toEqual([]);
    expect(parseWorktreePaths("")).toEqual([]);
    expect(parseWorktreePaths("{not json")).toEqual([]);
    expect(parseWorktreePaths('{"a":1}')).toEqual([]); // object, not array
  });

  it("drops non-string entries", () => {
    expect(parseWorktreePaths('["/a", 42, null, "/b"]')).toEqual(["/a", "/b"]);
  });
});

describe("worktreePathsToRepositories", () => {
  it("maps paths to ProjectRepository rows, first is primary, name = basename", () => {
    const repos = worktreePathsToRepositories(
      ["C:\\wt\\etl-engine", "/wt/gridops-cop"],
      "proj-1"
    );
    expect(repos).toEqual([
      {
        id: "C:\\wt\\etl-engine",
        project_id: "proj-1",
        name: "etl-engine", // basename, separator-agnostic (handles \ and /)
        path: "C:\\wt\\etl-engine",
        is_primary: true,
        sort_order: 0,
      },
      {
        id: "/wt/gridops-cop",
        project_id: "proj-1",
        name: "gridops-cop",
        path: "/wt/gridops-cop",
        is_primary: false,
        sort_order: 1,
      },
    ]);
  });

  it("is empty for no paths", () => {
    expect(worktreePathsToRepositories([], "p")).toEqual([]);
  });
});
