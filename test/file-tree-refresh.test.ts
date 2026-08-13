import { describe, it, expect } from "vitest";
import { applyDirRefresh } from "../lib/file-utils";
import type { FileNode } from "../lib/file-utils";

function dir(path: string): FileNode {
  return { name: path.split("/").pop() || path, path, type: "directory" };
}

function file(path: string): FileNode {
  return { name: path.split("/").pop() || path, path, type: "file" };
}

describe("applyDirRefresh", () => {
  it("replaces children of a refreshed directory", () => {
    const loadedChildren = new Map<string, FileNode[]>([
      ["/repo/src", [file("/repo/src/old.ts")]],
    ]);
    const expanded = new Set(["/repo/src"]);

    const next = applyDirRefresh(loadedChildren, expanded, [
      {
        path: "/repo/src",
        files: [file("/repo/src/new.ts"), dir("/repo/src/lib")],
      },
    ]);

    expect(next.loadedChildren.get("/repo/src")).toEqual([
      file("/repo/src/new.ts"),
      dir("/repo/src/lib"),
    ]);
    expect(next.expanded.has("/repo/src")).toBe(true);
  });

  it("replaces a deleted dir's listing with the empty array the API returns", () => {
    // listDirectory swallows ENOENT and returns [], so a deleted dir comes
    // back as an empty listing; its parent drops the node in its own refresh.
    const loadedChildren = new Map<string, FileNode[]>([
      ["/repo/gone", [file("/repo/gone/a.ts")]],
    ]);
    const expanded = new Set(["/repo/gone"]);

    const next = applyDirRefresh(loadedChildren, expanded, [
      { path: "/repo/gone", files: [] },
    ]);

    expect(next.loadedChildren.get("/repo/gone")).toEqual([]);
    expect(next.expanded.has("/repo/gone")).toBe(true);
  });

  it("leaves dirs without a result (transient failures) untouched", () => {
    // The refresh effect skips failed fetches entirely, so one bad poll tick
    // must not collapse expanded dirs or wipe their cached listings.
    const loadedChildren = new Map<string, FileNode[]>([
      ["/repo/a", [file("/repo/a/x.ts")]],
      ["/repo/b", [file("/repo/b/y.ts")]],
    ]);
    const expanded = new Set(["/repo/a", "/repo/b"]);

    const next = applyDirRefresh(loadedChildren, expanded, [
      { path: "/repo/a", files: [file("/repo/a/z.ts")] },
    ]);

    expect(next.loadedChildren.get("/repo/b")).toEqual([file("/repo/b/y.ts")]);
    expect(next.expanded.has("/repo/b")).toBe(true);
    expect(next.loadedChildren.get("/repo/a")).toEqual([file("/repo/a/z.ts")]);
  });

  it("does not mutate the input maps", () => {
    const loadedChildren = new Map<string, FileNode[]>([
      ["/repo/src", [file("/repo/src/old.ts")]],
    ]);
    const expanded = new Set(["/repo/src"]);

    applyDirRefresh(loadedChildren, expanded, [
      { path: "/repo/src", files: [file("/repo/src/new.ts")] },
    ]);

    expect(loadedChildren.get("/repo/src")).toEqual([file("/repo/src/old.ts")]);
    expect(expanded.size).toBe(1);
  });

  it("handles an empty result set as a no-op", () => {
    const loadedChildren = new Map<string, FileNode[]>([
      ["/repo/src", [file("/repo/src/a.ts")]],
    ]);
    const expanded = new Set(["/repo/src"]);

    const next = applyDirRefresh(loadedChildren, expanded, []);

    expect(next.loadedChildren.get("/repo/src")).toEqual([
      file("/repo/src/a.ts"),
    ]);
    expect(next.expanded.has("/repo/src")).toBe(true);
  });
});
