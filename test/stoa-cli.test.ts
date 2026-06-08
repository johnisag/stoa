import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The CLI is a CommonJS script (runs under plain `node`); load it via
// createRequire so this ESM/TS test can import its pure helpers. main() is
// guarded by `require.main === module`, so importing has no side effects.
const require = createRequire(import.meta.url);
const CLI_PATH = "../scripts/stoa.js";

const {
  isGitInstall,
  parseEnvFile,
  loadEnvFile,
  hiddenWindowOption,
  blockingDirty,
  buildIsComplete,
  collidingUntracked,
} = require(CLI_PATH) as {
  isGitInstall: (dir?: string) => boolean;
  parseEnvFile: (content: string) => Record<string, string>;
  loadEnvFile: (dir: string) => Record<string, string>;
  hiddenWindowOption: (platform?: string) => Record<string, boolean>;
  blockingDirty: (porcelain: string | null) => string[];
  buildIsComplete: (dir?: string) => boolean;
  collidingUntracked: (
    porcelain: string | null,
    incoming: string | null
  ) => string[];
};

/**
 * The CLI captures PORT / serverEnv from process.env at module load, so to
 * test port resolution we set the env first, bust the require cache, then
 * re-require a fresh instance. Returns the freshly-loaded module.
 */
function loadCliWith(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  // STOA_SKIP_ENV_FILE disables the CLI's repo-root .env load at module load,
  // so a developer's local .env (e.g. STOA_PORT=3022 for dogfooding) can't make
  // these port-resolution assertions non-deterministic. No filesystem mutation.
  const keys = ["STOA_PORT", "PORT", "STOA_SKIP_ENV_FILE", "STOA_HOME"];
  const overrides: Record<string, string | undefined> = {
    ...env,
    STOA_SKIP_ENV_FILE: "1",
    // Isolate STOA_HOME to a fresh empty temp dir so the new persisted-port
    // fallback (~/.stoa/stoa.port) can't read the developer's real port file and
    // make these assertions non-deterministic. A test wanting to exercise the
    // fallback passes its own STOA_HOME (a dir it pre-seeded with stoa.port).
    STOA_HOME: env.STOA_HOME ?? freshDir(),
  };
  for (const k of keys) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  delete require.cache[require.resolve(CLI_PATH)];
  try {
    return require(CLI_PATH) as {
      PORT: string;
      serverEnv: () => NodeJS.ProcessEnv;
    };
  } finally {
    // Restore env so cases don't leak into each other.
    for (const k of keys) {
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

describe("stoa CLI: Windows child windows", () => {
  it("requests hidden child windows only on Windows", () => {
    expect(hiddenWindowOption("win32")).toEqual({ windowsHide: true });
    expect(hiddenWindowOption("linux")).toEqual({});
    expect(hiddenWindowOption("darwin")).toEqual({});
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

describe("stoa CLI: blockingDirty (update dirty-tree guard ignores untracked)", () => {
  it("returns [] for a clean tree (null or empty porcelain)", () => {
    expect(blockingDirty(null)).toEqual([]);
    expect(blockingDirty("")).toEqual([]);
  });
  it("ignores untracked files (?? lines) — safe across a ff-only pull", () => {
    expect(blockingDirty("?? scratch.log\n?? tmp/output.txt")).toEqual([]);
  });
  it("blocks on tracked changes (staged/modified/deleted/renamed/conflict)", () => {
    const porcelain =
      " M server.ts\nA  new.ts\n D gone.ts\nR  a.ts -> b.ts\nUU conflict.ts\n?? untracked.txt";
    const blocked = blockingDirty(porcelain);
    expect(blocked).toEqual([
      " M server.ts",
      "A  new.ts",
      " D gone.ts",
      "R  a.ts -> b.ts",
      "UU conflict.ts",
    ]);
    expect(blocked).not.toContain("?? untracked.txt"); // untracked never blocks
  });
});

describe("stoa CLI: buildIsComplete (catch a partial .next before it crash-loops)", () => {
  it("is true only when .next has prerender-manifest.json AND BUILD_ID", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".next"));
    writeFileSync(join(dir, ".next", "prerender-manifest.json"), "{}");
    writeFileSync(join(dir, ".next", "BUILD_ID"), "abc");
    expect(buildIsComplete(dir)).toBe(true);
  });
  it("is false when prerender-manifest.json is missing (the interrupted-build case)", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".next"));
    writeFileSync(join(dir, ".next", "BUILD_ID"), "abc"); // present, but no manifest
    expect(buildIsComplete(dir)).toBe(false);
  });
  it("is false when BUILD_ID is missing (manifest alone is not enough)", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".next"));
    writeFileSync(join(dir, ".next", "prerender-manifest.json"), "{}"); // no BUILD_ID
    expect(buildIsComplete(dir)).toBe(false);
  });
  it("is false when .next is absent entirely", () => {
    expect(buildIsComplete(freshDir())).toBe(false);
  });
});

describe("stoa CLI: collidingUntracked (name files git stash can't move)", () => {
  it("returns untracked (??) files that collide with incoming paths", () => {
    const porcelain = "?? app/new-page.tsx\n?? scratch.log\n M server.ts";
    const incoming = "app/new-page.tsx\nlib/other.ts";
    expect(collidingUntracked(porcelain, incoming)).toEqual([
      "app/new-page.tsx",
    ]);
  });
  it("ignores tracked changes and non-colliding untracked files", () => {
    expect(
      collidingUntracked(" M server.ts\n?? scratch.log", "lib/x.ts")
    ).toEqual([]);
  });
  it("returns [] for empty/null inputs", () => {
    expect(collidingUntracked(null, null)).toEqual([]);
    expect(collidingUntracked("", "")).toEqual([]);
  });
});

describe("stoa CLI: persisted port fallback (~/.stoa/stoa.port)", () => {
  it("falls back to stoa.port when neither STOA_PORT nor PORT is set", () => {
    const home = freshDir();
    writeFileSync(join(home, "stoa.port"), "3033");
    const cli = loadCliWith({ STOA_HOME: home });
    expect(cli.PORT).toBe("3033");
  });
  it("env STOA_PORT still wins over the persisted file", () => {
    const home = freshDir();
    writeFileSync(join(home, "stoa.port"), "3033");
    const cli = loadCliWith({ STOA_HOME: home, STOA_PORT: "3022" });
    expect(cli.PORT).toBe("3022");
  });
  it("ignores a garbage (non-numeric) port file and defaults to 3011", () => {
    const home = freshDir();
    writeFileSync(join(home, "stoa.port"), "not-a-port");
    const cli = loadCliWith({ STOA_HOME: home });
    expect(cli.PORT).toBe("3011");
  });
});

describe("stoa CLI: parseEnvFile (dependency-free .env parsing)", () => {
  it("parses plain KEY=VALUE pairs", () => {
    expect(parseEnvFile("STOA_PORT=3022\nFOO=bar")).toEqual({
      STOA_PORT: "3022",
      FOO: "bar",
    });
  });

  it("ignores blank lines and # comments", () => {
    const parsed = parseEnvFile(
      "# a comment\n\nSTOA_PORT=3022\n   # indented\n"
    );
    expect(parsed).toEqual({ STOA_PORT: "3022" });
  });

  it("strips a leading `export ` and surrounding quotes", () => {
    expect(parseEnvFile('export STOA_PORT="3022"')).toEqual({
      STOA_PORT: "3022",
    });
    expect(parseEnvFile("TOKEN='ab c'")).toEqual({ TOKEN: "ab c" });
  });

  it("tolerates spaces around the = and keeps inner = signs", () => {
    expect(parseEnvFile("STOA_PORT = 3022\nURL=http://x/?a=b")).toEqual({
      STOA_PORT: "3022",
      URL: "http://x/?a=b",
    });
  });

  it("skips malformed keys and lines without =", () => {
    expect(parseEnvFile("123BAD=x\nnoequals\nOK=1")).toEqual({ OK: "1" });
  });

  it("strips a leading UTF-8 BOM (Windows editors write .env BOM-first)", () => {
    expect(parseEnvFile("\uFEFFSTOA_PORT=3022\nFOO=bar")).toEqual({
      STOA_PORT: "3022",
      FOO: "bar",
    });
  });
});

describe("stoa CLI: loadEnvFile (hydrate process.env without clobbering)", () => {
  let dir: string;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    dir = freshDir();
    saved = {
      STOA_PORT: process.env.STOA_PORT,
      PORT: process.env.PORT,
      FROM_FILE: process.env.FROM_FILE,
    };
    delete process.env.STOA_PORT;
    delete process.env.PORT;
    delete process.env.FROM_FILE;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("is a silent no-op when no .env exists", () => {
    expect(loadEnvFile(dir)).toEqual({});
    expect(process.env.STOA_PORT).toBeUndefined();
  });

  it("sets keys from .env when they are unset in the environment", () => {
    writeFileSync(join(dir, ".env"), "STOA_PORT=3022\nFROM_FILE=yes\n");
    loadEnvFile(dir);
    expect(process.env.STOA_PORT).toBe("3022");
    expect(process.env.FROM_FILE).toBe("yes");
  });

  it("does NOT clobber a value already in the real environment", () => {
    process.env.STOA_PORT = "9999"; // real env wins
    writeFileSync(join(dir, ".env"), "STOA_PORT=3022\nFROM_FILE=yes\n");
    loadEnvFile(dir);
    expect(process.env.STOA_PORT).toBe("9999");
    expect(process.env.FROM_FILE).toBe("yes"); // unset key still filled
  });
});
