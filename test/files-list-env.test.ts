import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listDirectory } from "@/lib/files";

// Regression: .env was in DEFAULT_EXCLUDES, so the explorer never listed it even
// though users need to see/edit it (as in VS Code) and the content API already
// serves a known .env path. Pin that .env is now LISTED while the genuinely-noisy
// excludes (node_modules, .git, *.log, *.db) stay hidden.
describe("listDirectory: .env visibility", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "stoa-files-env-"));
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    writeFileSync(join(root, ".env.local"), "LOCAL=1\n");
    writeFileSync(join(root, ".env.production.local"), "PROD=1\n");
    writeFileSync(join(root, "app.log"), "noise\n");
    writeFileSync(join(root, "data.db"), "x\n");
    writeFileSync(join(root, "index.ts"), "export {};\n");
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, ".git"));
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

  it("still hides node_modules, .git, *.log and *.db", () => {
    const names = listDirectory(root).map((n) => n.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).not.toContain("app.log");
    expect(names).not.toContain("data.db");
  });

  it("still lists ordinary source files", () => {
    const names = listDirectory(root).map((n) => n.name);
    expect(names).toContain("index.ts");
  });
});
