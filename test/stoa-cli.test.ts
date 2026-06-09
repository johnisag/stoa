import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { createRequire } from "module";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The CLI is a CommonJS script (runs under plain `node`); load it via
// createRequire so this ESM/TS test can import its pure helpers. main() is
// guarded by `require.main === module`, so importing has no side effects.
const originalSkipEnvFile = process.env.STOA_SKIP_ENV_FILE;
process.env.STOA_SKIP_ENV_FILE = "1";
const require = createRequire(import.meta.url);
const CLI_PATH = "../scripts/stoa.js";
const {
  isGitInstall,
  parseEnvFile,
  loadEnvFile,
  commandSpec,
  buildIsComplete,
} = require(CLI_PATH) as {
  isGitInstall: (dir?: string) => boolean;
  parseEnvFile: (content: string) => Record<string, string>;
  loadEnvFile: (dir: string) => Record<string, string>;
  commandSpec: (
    cmd: string,
    args?: string[]
  ) => { file: string; args: string[] };
  buildIsComplete: (dir?: string) => boolean;
};

function loadCliWith(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  const keys = ["STOA_PORT", "PORT", "STOA_SKIP_ENV_FILE"] as const;
  const overrides: Record<(typeof keys)[number], string | undefined> = {
    STOA_PORT: env.STOA_PORT,
    PORT: env.PORT,
    STOA_SKIP_ENV_FILE: "1",
  };

  for (const key of keys) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }

  delete require.cache[require.resolve(CLI_PATH)];
  try {
    return require(CLI_PATH) as {
      PORT: string;
      serverEnv: () => NodeJS.ProcessEnv;
    };
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
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
  delete require.cache[require.resolve(CLI_PATH)];
});

afterAll(() => {
  if (originalSkipEnvFile === undefined) delete process.env.STOA_SKIP_ENV_FILE;
  else process.env.STOA_SKIP_ENV_FILE = originalSkipEnvFile;
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

  it("returns true when .git is a file (linked git worktree)", () => {
    const dir = freshDir();
    writeFileSync(join(dir, ".git"), "gitdir: ../.git/worktrees/repo\n");
    expect(isGitInstall(dir)).toBe(true);
  });
});

describe("stoa CLI: port resolution", () => {
  it("defaults to 3011 when neither STOA_PORT nor PORT is set", () => {
    const cli = loadCliWith({ STOA_PORT: undefined, PORT: undefined });
    expect(cli.PORT).toBe("3011");
    expect(cli.serverEnv().PORT).toBe("3011");
  });

  it("maps STOA_PORT into the spawned server env as PORT", () => {
    const cli = loadCliWith({ STOA_PORT: "3022", PORT: undefined });
    expect(cli.PORT).toBe("3022");
    expect(cli.serverEnv().PORT).toBe("3022");
  });

  it("honors raw PORT only when STOA_PORT is unset", () => {
    expect(loadCliWith({ STOA_PORT: undefined, PORT: "4000" }).PORT).toBe(
      "4000"
    );
    expect(loadCliWith({ STOA_PORT: "3022", PORT: "4000" }).PORT).toBe("3022");
  });

  it("emits exactly one canonical PORT key", () => {
    const saved = { ...process.env };
    try {
      process.env.Port = "9999";
      const env = loadCliWith({
        STOA_PORT: "3022",
        PORT: undefined,
      }).serverEnv();
      expect(
        Object.keys(env).filter((k) => k.toUpperCase() === "PORT")
      ).toEqual(["PORT"]);
      expect(env.PORT).toBe("3022");
    } finally {
      for (const key of Object.keys(process.env))
        if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe("stoa CLI: .env loading", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      STOA_PORT: process.env.STOA_PORT,
      FROM_FILE: process.env.FROM_FILE,
      STOA_SKIP_ENV_FILE: process.env.STOA_SKIP_ENV_FILE,
    };
    delete process.env.STOA_PORT;
    delete process.env.FROM_FILE;
    delete process.env.STOA_SKIP_ENV_FILE;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("parses comments, export prefixes, quotes, spaces, BOM, and inner equals", () => {
    expect(
      parseEnvFile(
        "\uFEFF# comment\nexport STOA_PORT = \"3022\"\nTOKEN='a=b'\nBAD-KEY=x\n"
      )
    ).toEqual({ STOA_PORT: "3022", TOKEN: "a=b" });
  });

  it("loads .env without clobbering real environment values", () => {
    const dir = freshDir();
    process.env.STOA_PORT = "9999";
    writeFileSync(join(dir, ".env"), "STOA_PORT=3022\nFROM_FILE=yes\n");

    expect(loadEnvFile(dir)).toEqual({
      STOA_PORT: "3022",
      FROM_FILE: "yes",
    });
    expect(process.env.STOA_PORT).toBe("9999");
    expect(process.env.FROM_FILE).toBe("yes");
  });
});

describe("stoa CLI: command resolution", () => {
  it("resolves commands from PATH without shell:true", () => {
    const dir = freshDir();
    const savedPath = process.env.PATH;
    const savedPathext = process.env.PATHEXT;
    const name = process.platform === "win32" ? "fake-tool.cmd" : "fake-tool";
    const fake = join(dir, name);
    writeFileSync(fake, "");
    if (process.platform !== "win32") chmodSync(fake, 0o755);

    process.env.PATH = dir;
    process.env.PATHEXT = ".CMD";
    try {
      const spec = commandSpec("fake-tool", ["a"]);
      if (process.platform === "win32") {
        expect(spec.file.toLowerCase()).toContain("cmd");
        expect(spec.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
        expect(spec.args[3].toLowerCase()).toBe(fake.toLowerCase());
        expect(spec.args.slice(4)).toEqual(["a"]);
      } else {
        expect(spec).toEqual({ file: fake, args: ["a"] });
      }
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedPathext === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = savedPathext;
    }
  });
});

describe("stoa CLI: build artifact verification", () => {
  it("requires the production Next.js artifacts", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".next"));
    expect(buildIsComplete(dir)).toBe(false);

    writeFileSync(join(dir, ".next", "BUILD_ID"), "build\n");
    writeFileSync(join(dir, ".next", "prerender-manifest.json"), "{}");
    expect(buildIsComplete(dir)).toBe(true);
  });
});
