import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { resolveDbPath } from "../lib/db/index";

/**
 * The DB must resolve OUTSIDE the repo clone (to STOA_HOME) so a re-clone / reset
 * of ~/.stoa/repo can never destroy session history, AND so the path doesn't depend
 * on the launch cwd (a `stoa`-launched server can run from a non-writable cwd, where
 * a relative `./stoa.db` fails to open and 500s every DB route — the macOS DB-500
 * regression a "return to June 5 stable" revert reintroduced). These tests pin that
 * resolution: STOA_HOME default, ~ expansion, and the legacy in-repo fallback that
 * prevents an upgrade from orphaning an existing DB.
 */
describe("resolveDbPath (DB lives in STOA_HOME, never inside the repo)", () => {
  const saved = {
    DB_PATH: process.env.DB_PATH,
    STOA_HOME: process.env.STOA_HOME,
  };
  const cwd = process.cwd();
  const tmps: string[] = [];
  const fresh = () => {
    const d = mkdtempSync(join(tmpdir(), "stoa-dbpath-"));
    tmps.push(d);
    return d;
  };

  beforeEach(() => {
    delete process.env.DB_PATH;
    delete process.env.STOA_HOME;
  });
  afterEach(() => {
    process.chdir(cwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("defaults to STOA_HOME/stoa.db, NOT cwd/stoa.db", () => {
    const home = fresh();
    const repo = fresh();
    process.env.STOA_HOME = home;
    process.chdir(repo); // pretend we're running from inside the repo clone
    expect(resolveDbPath()).toBe(join(home, "stoa.db"));
  });

  it("treats an empty DB_PATH as unset (falls through to STOA_HOME)", () => {
    const home = fresh();
    process.env.STOA_HOME = home;
    process.env.DB_PATH = "";
    process.chdir(fresh()); // a repo dir with no legacy stoa.db
    expect(resolveDbPath()).toBe(join(home, "stoa.db"));
  });

  it("honors an explicit DB_PATH and expands a leading ~", () => {
    process.env.DB_PATH = "~/.stoa/stoa.db";
    expect(resolveDbPath()).toBe(join(homedir(), ".stoa", "stoa.db"));
  });

  it("uses an absolute DB_PATH verbatim", () => {
    const abs = join(fresh(), "custom.db");
    process.env.DB_PATH = abs;
    expect(resolveDbPath()).toBe(abs);
  });

  it("migrates a legacy in-repo ./stoa.db into the canonical location (sticky, no fork)", () => {
    const home = fresh(); // STOA_HOME has NO stoa.db yet
    const repo = fresh();
    writeFileSync(join(repo, "stoa.db"), "legacydata"); // pre-existing legacy DB
    process.env.STOA_HOME = home;
    process.chdir(repo);
    const resolved = resolveDbPath();
    // Converges on the canonical path (not the legacy one) so a later empty
    // canonical can't shadow it...
    expect(resolved).toBe(join(home, "stoa.db"));
    // ...and the legacy data was physically migrated, not abandoned.
    expect(readFileSync(resolved, "utf8")).toBe("legacydata");
  });

  it("prefers the canonical STOA_HOME DB once it exists, ignoring a legacy one", () => {
    const home = fresh();
    const repo = fresh();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "stoa.db"), ""); // canonical exists
    writeFileSync(join(repo, "stoa.db"), ""); // legacy also exists
    process.env.STOA_HOME = home;
    process.chdir(repo);
    expect(resolveDbPath()).toBe(join(home, "stoa.db"));
  });
});
