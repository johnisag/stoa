import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "module";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The CLI is a CommonJS script (runs under plain `node`); load it via
// createRequire so this ESM/TS test can import its pure helpers. main() is
// guarded by `require.main === module`, so importing has no side effects.
const require = createRequire(import.meta.url);
const { isGitInstall } = require("../scripts/stoa.js") as {
  isGitInstall: (dir?: string) => boolean;
};

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "stoa-cli-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

describe("stoa CLI: isGitInstall (git-checkout vs npm-global detection)", () => {
  it("returns false for a plain directory (e.g. an npm-global install)", () => {
    expect(isGitInstall(freshDir())).toBe(false);
  });

  it("returns true when a .git directory is present (a git clone)", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".git"));
    expect(isGitInstall(dir)).toBe(true);
  });
});
