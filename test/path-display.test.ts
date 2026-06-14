import { describe, it, expect } from "vitest";
import { baseName, dirName, joinPath, relativePath } from "@/lib/path-display";

describe("path-display helpers", () => {
  describe("baseName", () => {
    it("is separator-agnostic", () => {
      expect(baseName("C:\\my-projects\\stoa")).toBe("stoa");
      expect(baseName("/a/b/c")).toBe("c");
      expect(baseName("")).toBe("");
    });
  });

  describe("dirName", () => {
    it("returns the directory portion of a path", () => {
      expect(dirName("/a/b/c")).toBe("/a/b");
      expect(dirName("C:\\Users\\foo\\bar")).toBe("C:\\Users\\foo");
    });

    it("preserves the input separator style", () => {
      expect(dirName("C:/Users/foo")).toBe("C:\\Users");
      expect(dirName("/a/b/c")).toBe("/a/b");
    });

    it("returns the original path for a root path", () => {
      expect(dirName("/")).toBe("/");
      expect(dirName("C:\\")).toBe("C:\\");
    });
  });

  describe("joinPath", () => {
    it("detects the separator from the base", () => {
      expect(joinPath("C:\\Users", "foo")).toBe("C:\\Users\\foo");
      expect(joinPath("/home", "foo")).toBe("/home/foo");
    });
  });

  describe("relativePath", () => {
    it("returns a path relative to the base with forward slashes", () => {
      expect(relativePath("/a/b/c", "/a/b")).toBe("c");
      expect(relativePath("C:\\a\\b\\c", "C:\\a\\b")).toBe("c");
    });
  });
});
