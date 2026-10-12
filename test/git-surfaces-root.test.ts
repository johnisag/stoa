import { describe, it, expect } from "vitest";
import { resolveGitSurfacesRoot } from "@/lib/git-surfaces-root";

const FILES_ROOT = "/w/proj/subdir";
const STORED = "/w/proj";

describe("resolveGitSurfacesRoot", () => {
  it("anchors on the resolved repo root (never a subdirectory cwd)", () => {
    expect(resolveGitSurfacesRoot("/w/proj", FILES_ROOT, STORED)).toBe(
      "/w/proj"
    );
  });

  it("falls back to the Files root while the resolution is loading", () => {
    expect(resolveGitSurfacesRoot(undefined, FILES_ROOT, STORED)).toBe(
      FILES_ROOT
    );
  });

  it("keeps git on the stored directory when the cwd is not inside a repo", () => {
    expect(resolveGitSurfacesRoot(null, FILES_ROOT, STORED)).toBe(STORED);
  });

  it("falls back to the Files root when not a repo and no stored directory exists", () => {
    expect(resolveGitSurfacesRoot(null, FILES_ROOT, null)).toBe(FILES_ROOT);
  });

  it("returns null when everything is missing", () => {
    expect(resolveGitSurfacesRoot(undefined, null, null)).toBeNull();
    expect(resolveGitSurfacesRoot(null, null, null)).toBeNull();
  });
});
