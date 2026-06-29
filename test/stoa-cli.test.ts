import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import { createRequire } from "module";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import net from "net";

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
  parseNodeMajor,
  checkNodeVersion,
  doctorExitCode,
  formatDoctorLine,
  parsePort,
  checkPortFree,
  NODE_MIN_MAJOR,
  NATIVE_MODULES,
} = require(CLI_PATH) as {
  isGitInstall: (dir?: string) => boolean;
  parseEnvFile: (content: string) => Record<string, string>;
  loadEnvFile: (dir: string) => Record<string, string>;
  commandSpec: (
    cmd: string,
    args?: string[]
  ) => { file: string; args: string[] };
  buildIsComplete: (dir?: string) => boolean;
  parseNodeMajor: (v: string) => number | null;
  checkNodeVersion: (
    v: string,
    min?: number
  ) => { name: string; status: string; detail: string; hint?: string };
  doctorExitCode: (results: { status: string }[]) => number;
  formatDoctorLine: (r: {
    name: string;
    status: string;
    detail: string;
    hint?: string;
  }) => string;
  parsePort: (v: unknown) => number | null;
  checkPortFree: (port: number, host?: string) => Promise<boolean>;
  NODE_MIN_MAJOR: number;
  NATIVE_MODULES: string[];
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
  // In VM test pools the module cannot be reliably re-evaluated per case, so
  // load it once and vary env via vi.stubEnv (which is visible to the getter).
  const cli = loadCliWith({ STOA_PORT: undefined, PORT: undefined });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 3011 when neither STOA_PORT nor PORT is set", () => {
    expect(cli.PORT).toBe("3011");
    expect(cli.serverEnv().PORT).toBe("3011");
  });

  it("maps STOA_PORT into the spawned server env as PORT", () => {
    vi.stubEnv("STOA_PORT", "3022");
    expect(cli.PORT).toBe("3022");
    expect(cli.serverEnv().PORT).toBe("3022");
  });

  it("honors raw PORT only when STOA_PORT is unset", () => {
    vi.stubEnv("PORT", "4000");
    expect(cli.PORT).toBe("4000");
    vi.stubEnv("STOA_PORT", "3022");
    expect(cli.PORT).toBe("3022");
  });

  it("emits exactly one canonical PORT key", () => {
    vi.stubEnv("Port", "9999");
    vi.stubEnv("STOA_PORT", "3022");
    const env = cli.serverEnv();
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "PORT")).toEqual([
      "PORT",
    ]);
    expect(env.PORT).toBe("3022");
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
        // cmd.exe /c with the path + args as their OWN argv entries (Node quotes
        // each; no /s, so the quotes survive). The shim path is one element.
        expect(spec.args[0]).toBe("/c");
        expect(spec.args[1].toLowerCase()).toBe(fake.toLowerCase());
        expect(spec.args.slice(2)).toEqual(["a"]);
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

  // Regression: `stoa update`/`install` silently failed when npm/node lived under a
  // spaced path (`C:\Program Files\...`). The old `/d /s /c` form let cmd strip
  // Node's quotes and split the path → `'C:\Program' is not recognized`, and the
  // update then restarted on the OLD build. The spaced path must stay a SINGLE argv
  // element so Node quotes it and plain `/c` keeps it intact.
  it("keeps a spaced .cmd path as one argv element (the 'C:\\Program Files' bug)", () => {
    // An absolute, non-existent path resolves to itself (resolveCommand → null →
    // fallback), so we control the spaces without needing the file on disk.
    const npm = "C:\\Program Files\\nodejs\\npm.cmd";
    const spec = commandSpec(npm, ["install", "--legacy-peer-deps"]);
    if (process.platform === "win32") {
      expect(spec.file.toLowerCase()).toContain("cmd");
      // No /s, and the spaced path is its OWN element (not split or concatenated).
      expect(spec.args).toEqual(["/c", npm, "install", "--legacy-peer-deps"]);
    } else {
      // POSIX never routes through cmd: a non-existent absolute path passes through.
      expect(spec).toEqual({
        file: npm,
        args: ["install", "--legacy-peer-deps"],
      });
    }
  });
});

describe("stoa CLI: native-module rebuild list (ABI-mismatch fix)", () => {
  // install/update force-rebuild this set so a Node-version change can't leave a
  // stale ABI-mismatched binary (NODE_MODULE_VERSION mismatch → 500s every DB route).
  it("includes the native modules the server loads at runtime", () => {
    expect(NATIVE_MODULES.length).toBeGreaterThan(0);
    expect(NATIVE_MODULES).toContain("better-sqlite3"); // the DB binding
    expect(NATIVE_MODULES).toContain("node-pty"); // the pty backend
  });

  it("lists only real package.json dependencies (the list can't silently go stale)", () => {
    const pkg = require("../package.json") as {
      dependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};
    for (const mod of NATIVE_MODULES) {
      // A phantom entry would make `npm rebuild` error or no-op; a missing-from-deps
      // entry means the list drifted from what's actually installed.
      expect(
        deps[mod],
        `${mod} must be a dependency in package.json`
      ).toBeDefined();
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

describe("stoa CLI: doctor (preflight) pure helpers", () => {
  it("parseNodeMajor extracts the major from a version string", () => {
    expect(parseNodeMajor("v24.14.0")).toBe(24);
    expect(parseNodeMajor("24.0.1")).toBe(24); // no leading v
    expect(parseNodeMajor("v20.11.1")).toBe(20);
    expect(parseNodeMajor("")).toBeNull();
    expect(parseNodeMajor("nonsense")).toBeNull();
  });

  it("checkNodeVersion passes at/above the minimum, fails below", () => {
    expect(checkNodeVersion(`v${NODE_MIN_MAJOR}.0.0`).status).toBe("ok");
    expect(checkNodeVersion(`v${NODE_MIN_MAJOR + 3}.2.0`).status).toBe("ok");
    const low = checkNodeVersion(`v${NODE_MIN_MAJOR - 1}.0.0`);
    expect(low.status).toBe("fail");
    expect(low.hint).toBeTruthy(); // a failure carries an actionable hint
    expect(low.detail).toContain(String(NODE_MIN_MAJOR)); // tells you the minimum
  });

  it("checkNodeVersion warns (not fails) on an unparseable version", () => {
    expect(checkNodeVersion("garbage").status).toBe("warn");
  });

  it("doctorExitCode is 1 iff any check failed (a warn is advisory)", () => {
    expect(doctorExitCode([{ status: "ok" }, { status: "warn" }])).toBe(0);
    expect(doctorExitCode([{ status: "ok" }, { status: "fail" }])).toBe(1);
    expect(doctorExitCode([])).toBe(0);
  });

  it("formatDoctorLine shows the icon, and the hint only when not ok", () => {
    const ok = formatDoctorLine({
      name: "Node.js",
      status: "ok",
      detail: "v24",
    });
    expect(ok).toContain("Node.js: v24");
    expect(ok).not.toContain("→"); // ok lines have no hint arrow
    const bad = formatDoctorLine({
      name: "git",
      status: "fail",
      detail: "missing",
      hint: "Install Git",
    });
    expect(bad).toContain("git: missing");
    expect(bad).toContain("→ Install Git"); // hint rendered for a failure
  });

  it("formatDoctorLine renders the hint arrow for a WARN too (the common non-ok line)", () => {
    const warn = formatDoctorLine({
      name: "Agent CLIs",
      status: "warn",
      detail: "none found",
      hint: "Install one",
    });
    expect(warn).toContain("Agent CLIs: none found");
    expect(warn).toContain("→ Install one"); // warn carries its hint, like fail
  });

  it("parsePort accepts a clean 1–65535 port, rejects 0 / out-of-range / non-numeric", () => {
    expect(parsePort("3011")).toBe(3011);
    expect(parsePort(" 8080 ")).toBe(8080); // trimmed
    expect(parsePort("1")).toBe(1);
    expect(parsePort("65535")).toBe(65535);
    expect(parsePort("0")).toBeNull(); // would bind a random ephemeral port
    expect(parsePort("65536")).toBeNull(); // out of range
    expect(parsePort("-1")).toBeNull();
    expect(parsePort("3011x")).toBeNull(); // not purely numeric
    expect(parsePort("abc")).toBeNull();
    expect(parsePort("")).toBeNull();
    expect(parsePort(undefined)).toBeNull();
  });
});

describe("stoa CLI: checkPortFree (real net round-trip)", () => {
  it("reports an occupied port not-free and a released port free", async () => {
    const srv = net.createServer();
    const port: number = await new Promise((resolve) => {
      srv.listen(0, "127.0.0.1", () => {
        resolve((srv.address() as net.AddressInfo).port);
      });
    });
    expect(await checkPortFree(port, "127.0.0.1")).toBe(false); // held
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await checkPortFree(port, "127.0.0.1")).toBe(true); // released
  });
});
