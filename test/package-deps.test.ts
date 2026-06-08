import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Audit finding #5: the production server is launched via
 *   "start": "cross-env NODE_ENV=production tsx server.ts"
 * so `tsx` and `cross-env` are RUNTIME dependencies, not devDependencies. If
 * they sit in devDependencies, an install from a shell with NODE_ENV=production
 * omits them and the server can never start. And `prepare` must not hard-fail
 * the whole install when husky is absent (devDeps omitted). Lock both.
 */
describe("package.json: production runtime deps + safe prepare", () => {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8")
  ) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };

  it("ships tsx and cross-env as runtime dependencies (the prod entrypoint)", () => {
    for (const dep of ["tsx", "cross-env"]) {
      expect(
        pkg.dependencies[dep],
        `${dep} must be a runtime dependency`
      ).toBeDefined();
      expect(
        pkg.devDependencies[dep],
        `${dep} must NOT also be a devDependency`
      ).toBeUndefined();
    }
  });

  it("guards prepare so a missing husky (omitted devDeps) can't abort install", () => {
    // `husky || true` (or any guard) — must not be a bare `husky` that throws
    // and fails `npm install` when devDeps are omitted under NODE_ENV=production.
    // Must be an OR-guard (husky || ...) that ignores failure — NOT a bare
    // "husky" and NOT "husky && ..." (which still propagates a missing-husky error).
    expect(pkg.scripts.prepare).toMatch(/husky\s*\|\|/);
  });
});
