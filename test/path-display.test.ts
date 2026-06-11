import { describe, it, expect } from "vitest";
import {
  baseName,
  dirName,
  relativePath,
  formatPathsForAgent,
} from "@/lib/path-display";

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

describe("formatPathsForAgent", () => {
  it("appends a trailing space so the cursor lands ready", () => {
    expect(formatPathsForAgent("/home/u/proj/src/db.ts")).toBe(
      "/home/u/proj/src/db.ts "
    );
  });

  it("normalizes Windows separators to forward slashes", () => {
    expect(formatPathsForAgent("C:\\Users\\u\\proj\\db.ts")).toBe(
      "C:/Users/u/proj/db.ts "
    );
  });

  it("double-quotes a path containing whitespace", () => {
    expect(formatPathsForAgent("/home/u/my docs/notes.md")).toBe(
      '"/home/u/my docs/notes.md" '
    );
  });

  it("quotes a Windows path with spaces after normalizing", () => {
    expect(formatPathsForAgent("C:\\Program Files\\app\\x.ts")).toBe(
      '"C:/Program Files/app/x.ts" '
    );
  });

  it("joins multiple paths with a single space, quoting only those that need it", () => {
    expect(formatPathsForAgent(["/a/x.ts", "/a/my dir/y.ts", "/a/z.ts"])).toBe(
      '/a/x.ts "/a/my dir/y.ts" /a/z.ts '
    );
  });

  it("drops empty and blank entries", () => {
    expect(formatPathsForAgent(["", "  ", "/a/x.ts"])).toBe("/a/x.ts ");
  });

  it("returns an empty string when there is nothing to inject", () => {
    expect(formatPathsForAgent([])).toBe("");
    expect(formatPathsForAgent("")).toBe("");
  });

  it("strips control characters (keystroke-injection guard)", () => {
    // A filename can legally contain a raw newline/ESC/DEL; injected verbatim into
    // the pty those are keystrokes (Enter, bracketed-paste escapes). Build them via
    // fromCharCode so there are no literal control bytes in this source.
    const nl = String.fromCharCode(10);
    const esc = String.fromCharCode(27);
    const del = String.fromCharCode(127);
    expect(formatPathsForAgent(`/a/foo${nl}bar.ts`)).toBe("/a/foobar.ts ");
    expect(formatPathsForAgent(`/a/x${esc}${del}y.ts`)).toBe("/a/xy.ts ");
    // Strips before the whitespace check, so a path that's only control chars drops.
    expect(formatPathsForAgent(nl + esc)).toBe("");
  });
});
