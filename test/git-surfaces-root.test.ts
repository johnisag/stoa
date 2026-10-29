import { describe, it, expect } from "vitest";
import { isWithinRoot, resolveGitSurfacesRoot } from "@/lib/git-surfaces-root";

const FILES_ROOT = "/w/proj/subdir";
const STORED = "/w/proj";

describe("resolveGitSurfacesRoot", () => {
  it("anchors on the resolved repo root (never a subdirectory cwd)", () => {
    expect(resolveGitSurfacesRoot("/w/proj", FILES_ROOT, STORED)).toBe(
      "/w/proj"
    );
  });

  it("stays on the stored directory while the resolution is loading (never the unchecked subdir)", () => {
    expect(resolveGitSurfacesRoot(undefined, FILES_ROOT, STORED)).toBe(STORED);
  });

  it("falls back to the Files root while loading when no stored directory exists", () => {
    expect(resolveGitSurfacesRoot(undefined, FILES_ROOT, null)).toBe(
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

describe("isWithinRoot", () => {
  it("matches the root itself and paths inside it, either separator", () => {
    expect(isWithinRoot("/w/proj", "/w/proj/")).toBe(true);
    expect(isWithinRoot("/w/proj/src/lib", "/w/proj")).toBe(true);
    expect(isWithinRoot("C:\\w\\proj\\src", "C:/w/proj")).toBe(true);
  });

  it("rejects siblings sharing a name prefix and unrelated paths", () => {
    expect(isWithinRoot("/w/project", "/w/proj")).toBe(false);
    expect(isWithinRoot("/other", "/w/proj")).toBe(false);
  });
});
