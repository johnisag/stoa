import { describe, expect, it } from "vitest";
import { gitChangeEditorPath } from "@/lib/git-change-editor-path";

describe("gitChangeEditorPath", () => {
  it("opens single-repo changes relative to the session working directory", () => {
    expect(
      gitChangeEditorPath(
        { path: "src/app.ts", status: "modified" },
        "/work/project"
      )
    ).toBe("/work/project/src/app.ts");
  });

  it("uses the file repoPath for multi-repo workspace changes", () => {
    expect(
      gitChangeEditorPath(
        {
          path: "packages/ui/button.tsx",
          status: "modified",
          repoPath: "/work/project-ui",
        },
        "/work/workspace"
      )
    ).toBe("/work/project-ui/packages/ui/button.tsx");
  });

  it("keeps Windows paths native when joining git's slash paths", () => {
    expect(
      gitChangeEditorPath(
        {
          path: "src/index.ts",
          status: "untracked",
          repoPath: "C:\\work\\stoa",
        },
        "C:\\work\\workspace"
      )
    ).toBe("C:\\work\\stoa\\src\\index.ts");
  });

  it("does not open deleted files in the main editor", () => {
    expect(
      gitChangeEditorPath(
        { path: "src/removed.ts", status: "deleted" },
        "/work/project"
      )
    ).toBeNull();
  });
});
