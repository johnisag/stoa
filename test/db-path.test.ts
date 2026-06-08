import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { resolveDbPath } from "../lib/db/index";

/**
 * The DB must resolve OUTSIDE the repo clone (to STOA_HOME) so a re-clone / reset
 * of ~/.stoa/repo can never destroy session history (audit finding #1). These
 * tests pin that resolution: STOA_HOME default, ~ expansion, and the legacy
 * in-repo fallback that prevents an upgrade from orphaning an existing DB.
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

  it("falls back to a legacy in-repo ./stoa.db so an upgrade never orphans data", () => {
    const home = fresh(); // STOA_HOME has NO stoa.db yet
    const repo = fresh();
    writeFileSync(join(repo, "stoa.db"), ""); // a pre-existing legacy DB in the repo
    process.env.STOA_HOME = home;
    process.chdir(repo);
    // Compare against process.cwd(), not `repo`: on macOS chdir into /var/... is
    // reported as the realpath /private/var/..., and resolveDbPath() uses cwd.
    expect(resolveDbPath()).toBe(join(process.cwd(), "stoa.db"));
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
