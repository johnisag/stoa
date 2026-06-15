import { describe, it, expect } from "vitest";
import {
  flattenFileNodes,
  relativeDisplayPath,
  type FileNode,
} from "@/lib/file-utils";

const dir = (name: string, path: string, children: FileNode[]): FileNode => ({
  name,
  path,
  type: "directory",
  children,
});
const file = (name: string, path: string): FileNode => ({
  name,
  path,
  type: "file",
});

describe("flattenFileNodes", () => {
  it("returns only file nodes, depth-first, dropping directories", () => {
    const tree: FileNode[] = [
      file("a.ts", "/r/a.ts"),
      dir("src", "/r/src", [
        file("b.ts", "/r/src/b.ts"),
        dir("ui", "/r/src/ui", [file("c.tsx", "/r/src/ui/c.tsx")]),
      ]),
    ];
    expect(flattenFileNodes(tree).map((n) => n.path)).toEqual([
      "/r/a.ts",
      "/r/src/b.ts",
      "/r/src/ui/c.tsx",
    ]);
  });

  it("returns [] for an empty tree or a tree of only (possibly empty) directories", () => {
    expect(flattenFileNodes([])).toEqual([]);
    expect(
      flattenFileNodes([dir("empty", "/r/empty", []), dir("x", "/r/x", [])])
    ).toEqual([]);
  });
});

describe("relativeDisplayPath", () => {
  it("returns the path relative to base, forward-slashed", () => {
    expect(relativeDisplayPath("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
  });

  it("tolerates a trailing separator on base", () => {
    expect(relativeDisplayPath("/repo/", "/repo/src/a.ts")).toBe("src/a.ts");
  });

  it("normalizes Windows backslashes to forward slashes", () => {
    expect(relativeDisplayPath("C:\\repo", "C:\\repo\\src\\a.ts")).toBe(
      "src/a.ts"
    );
  });

  it("falls back to the bare filename when the path isn't under base", () => {
    expect(relativeDisplayPath("/repo", "/other/x.ts")).toBe("x.ts");
    expect(relativeDisplayPath("", "/other/x.ts")).toBe("x.ts");
  });
});
