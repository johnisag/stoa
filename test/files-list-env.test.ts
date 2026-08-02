import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listDirectory } from "@/lib/files";

// Regression: the explorer hid common gitignored artifacts (build dirs, logs,
// *.db, and previously .env) behind a large DEFAULT_EXCLUDES list, so developers
// could not see or open their own ignored files — unlike VS Code. The explorer now
// shows that content and excludes ONLY the dependency/VCS mega-directories that are
// pathological for the recursive directory search (node_modules, .git, venvs).
describe("listDirectory: gitignored content is visible", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "stoa-files-env-"));
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    writeFileSync(join(root, ".env.local"), "LOCAL=1\n");
    writeFileSync(join(root, ".env.production.local"), "PROD=1\n");
    writeFileSync(join(root, "app.log"), "noise\n");
    writeFileSync(join(root, "data.db"), "x\n");
    writeFileSync(join(root, "index.ts"), "export {};\n");
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, ".next"));
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".venv"));
    mkdirSync(join(root, "venv"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists .env and its variants", () => {
    const names = listDirectory(root).map((n) => n.name);
    expect(names).toContain(".env");
    expect(names).toContain(".env.local");
    expect(names).toContain(".env.production.local");
  });

  it("lists previously-hidden gitignored artifacts (logs, dbs, build dirs)", () => {
    const names = listDirectory(root).map((n) => n.name);
    expect(names).toContain("app.log");
    expect(names).toContain("data.db");
    expect(names).toContain("dist");
    expect(names).toContain(".next");
  });

  it("still hides the dependency/VCS mega-directories", () => {
    const names = listDirectory(root).map((n) => n.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).not.toContain(".venv");
    expect(names).not.toContain("venv");
  });

  it("still lists ordinary source files", () => {
    const names = listDirectory(root).map((n) => n.name);
    expect(names).toContain("index.ts");
  });
});

describe("listDirectory: symbolic-link boundary", () => {
  it("shows a linked directory without recursively enumerating its target", () => {
    const root = mkdtempSync(join(tmpdir(), "stoa-files-link-root-"));
    const outside = mkdtempSync(join(tmpdir(), "stoa-files-link-outside-"));
    try {
      writeFileSync(join(outside, "authority-secret"), "secret\n");
      const link = join(root, "linked-directory");
      symlinkSync(
        outside,
        link,
        process.platform === "win32" ? "junction" : "dir"
      );

      const result = listDirectory(root, { recursive: true, maxDepth: 3 });
      expect(result).toEqual([
        expect.objectContaining({
          name: "linked-directory",
          path: link,
          type: "directory",
        }),
      ]);
      expect(result[0]?.children).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("authority-secret");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
