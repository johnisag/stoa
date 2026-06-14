import { describe, it, expect } from "vitest";

import { toTildePath } from "@/components/DirectoryPicker";

// Regression test for B013: DirectoryPicker converted an absolute path back to
// "~"-relative form with a bare `selectedPath.startsWith(homePath)` — no path
// boundary. So a sibling directory whose name extends the home name (e.g.
// "/home/johnson" when home is "/home/john") matched and was mangled to "~son".
// The fix only rewrites when the path IS the home dir or is strictly inside it
// (home + separator). It is a client component, so the separator is derived
// from the home string itself rather than imported from lib/platform.

describe("toTildePath only rewrites the home dir or paths strictly inside it", () => {
  it("does NOT mangle a sibling whose name extends the home name (the bug)", () => {
    // POSIX: home "/home/john", sibling "/home/johnson" must stay untouched.
    expect(toTildePath("/home/johnson", "/home/john")).toBe("/home/johnson");
    // Windows form of the same trap.
    expect(toTildePath("C:\\Users\\johnson", "C:\\Users\\john")).toBe(
      "C:\\Users\\johnson"
    );
  });

  it("rewrites the home directory itself to '~'", () => {
    expect(toTildePath("/home/john", "/home/john")).toBe("~");
    expect(toTildePath("C:\\Users\\john", "C:\\Users\\john")).toBe("~");
  });

  it("rewrites a path strictly inside home to a ~-relative path", () => {
    expect(toTildePath("/home/john/projects", "/home/john")).toBe("~/projects");
    expect(toTildePath("C:\\Users\\john\\projects", "C:\\Users\\john")).toBe(
      "~\\projects"
    );
  });

  it("derives the separator from the home string, not the OS", () => {
    // A backslash-style home must use a backslash boundary, so a forward-slash
    // child does not accidentally match and a backslash child does.
    expect(toTildePath("C:\\Users\\john\\a", "C:\\Users\\john")).toBe("~\\a");
    // POSIX home: a backslash is just a filename char, not a boundary.
    expect(toTildePath("/home/john\\a", "/home/john")).toBe("/home/john\\a");
  });

  it("tolerates a trailing separator on the home path", () => {
    expect(toTildePath("/home/john/projects", "/home/john/")).toBe(
      "~/projects"
    );
    expect(toTildePath("/home/john", "/home/john/")).toBe("~");
  });

  it("returns the path unchanged when home is unknown (null)", () => {
    expect(toTildePath("/home/john/projects", null)).toBe(
      "/home/john/projects"
    );
  });

  it("leaves an unrelated path untouched", () => {
    expect(toTildePath("/var/www", "/home/john")).toBe("/var/www");
  });
});
