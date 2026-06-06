import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "module";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The CLI is a CommonJS script (runs under plain `node`); load it via
// createRequire so this ESM/TS test can import its pure helpers. main() is
// guarded by `require.main === module`, so importing has no side effects.
const require = createRequire(import.meta.url);
const CLI_PATH = "../scripts/stoa.js";

const { isGitInstall } = require(CLI_PATH) as {
  isGitInstall: (dir?: string) => boolean;
};

/**
 * The CLI captures PORT / serverEnv from process.env at module load, so to
 * test port resolution we set the env first, bust the require cache, then
 * re-require a fresh instance. Returns the freshly-loaded module.
 */
function loadCliWith(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of ["STOA_PORT", "PORT"]) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  delete require.cache[require.resolve(CLI_PATH)];
  try {
    return require(CLI_PATH) as {
      PORT: string;
      serverEnv: () => NodeJS.ProcessEnv;
    };
  } finally {
    // Restore env so cases don't leak into each other.
    for (const k of ["STOA_PORT", "PORT"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "stoa-cli-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
  // Reset the cached module to the default-env instance for other suites.
  delete require.cache[require.resolve(CLI_PATH)];
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

describe("stoa CLI: port resolution (STOA_PORT must reach the server)", () => {
  it("defaults to 3011 when neither STOA_PORT nor PORT is set", () => {
    const cli = loadCliWith({ STOA_PORT: undefined, PORT: undefined });
    expect(cli.PORT).toBe("3011");
    expect(cli.serverEnv().PORT).toBe("3011");
  });

  it("maps STOA_PORT into the spawned server env as PORT (the bug fix)", () => {
    // Regression: the CLI read STOA_PORT for display but the server reads
    // PORT, and the spawn passed process.env through unchanged — so STOA_PORT
    // never reached the server and it silently fell back to 3011.
    const cli = loadCliWith({ STOA_PORT: "3022", PORT: undefined });
    expect(cli.PORT).toBe("3022");
    expect(cli.serverEnv().PORT).toBe("3022");
  });

  it("honors a raw PORT when STOA_PORT is unset", () => {
    const cli = loadCliWith({ STOA_PORT: undefined, PORT: "4000" });
    expect(cli.PORT).toBe("4000");
    expect(cli.serverEnv().PORT).toBe("4000");
  });

  it("prefers STOA_PORT over a raw PORT when both are set", () => {
    const cli = loadCliWith({ STOA_PORT: "3022", PORT: "4000" });
    expect(cli.PORT).toBe("3022");
    expect(cli.serverEnv().PORT).toBe("3022");
  });

  it("preserves other environment variables in the spawned server env", () => {
    const cli = loadCliWith({ STOA_PORT: "3022", PORT: undefined });
    const env = cli.serverEnv();
    // PATH is always present; confirm we extend rather than replace the env.
    expect(env.PATH ?? env.Path).toBeDefined();
    expect(env.PORT).toBe("3022");
  });

  it("emits exactly one canonical PORT key (no case-variant collision)", () => {
    // On Windows env vars are case-insensitive; a naive spread of process.env
    // could leave a differently-cased key (e.g. "Port") next to our "PORT",
    // making the child's lookup ambiguous. serverEnv() must collapse to one.
    const saved = { ...process.env };
    try {
      // Seed a lowercase variant the way a quirky parent env might.
      (process.env as Record<string, string>).Port = "9999";
      const cli = loadCliWith({ STOA_PORT: "3022", PORT: undefined });
      const env = cli.serverEnv();
      const portKeys = Object.keys(env).filter(
        (k) => k.toUpperCase() === "PORT"
      );
      expect(portKeys).toEqual(["PORT"]);
      expect(env.PORT).toBe("3022");
    } finally {
      for (const k of Object.keys(process.env))
        if (!(k in saved)) delete (process.env as Record<string, string>)[k];
      Object.assign(process.env, saved);
    }
  });
});
