import { describe, it, expect } from "vitest";
import { baseName, dirName, relativePath } from "@/lib/path-display";

describe("baseName", () => {
  it("handles both separators", () => {
    expect(baseName("/a/b/c.ts")).toBe("c.ts");
    expect(baseName("C:\\a\\b\\c.ts")).toBe("c.ts");
    expect(baseName("c.ts")).toBe("c.ts");
  });
});

describe("dirName", () => {
  it("drops the last segment", () => {
    expect(dirName("/a/b/c.ts")).toBe("/a/b");
    expect(dirName("C:\\a\\b\\c.ts")).toBe("C:/a/b");
  });
});

describe("relativePath", () => {
  it("strips a POSIX base prefix", () => {
    expect(relativePath("/home/u/proj/src/db.ts", "/home/u/proj")).toBe(
      "src/db.ts"
    );
  });

  it("strips a Windows base prefix and normalizes to forward slashes", () => {
    expect(
      relativePath("C:\\Users\\u\\proj\\src\\db.ts", "C:\\Users\\u\\proj")
    ).toBe("src/db.ts");
  });

  it("tolerates a trailing separator on the base", () => {
    expect(relativePath("/home/u/proj/a.ts", "/home/u/proj/")).toBe("a.ts");
  });

  it("returns the basename when path equals base", () => {
    expect(relativePath("/home/u/proj", "/home/u/proj")).toBe("proj");
  });

  it("returns the original path when it is not under the base", () => {
    expect(relativePath("/etc/hosts", "/home/u/proj")).toBe("/etc/hosts");
  });

  it("does not treat a sibling prefix as a parent", () => {
    // "/home/u/project2" must not be considered under "/home/u/proj"
    expect(relativePath("/home/u/project2/x.ts", "/home/u/proj")).toBe(
      "/home/u/project2/x.ts"
    );
  });
});
