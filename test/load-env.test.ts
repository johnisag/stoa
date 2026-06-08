import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseEnvFile, loadEnvFile } from "../lib/load-env";

/**
 * The server must load the same `.env` the CLI does (audit finding #10) so that
 * editing the install's `.env` reaches a supervisor-launched `node server.ts`.
 * These lock the parser + the "real env wins" precedence.
 */
describe("load-env: parseEnvFile", () => {
  it("parses KEY=VALUE, strips `export ` and surrounding quotes", () => {
    expect(parseEnvFile("export STOA_PORT=\"3022\"\nTOKEN='ab c'")).toEqual({
      STOA_PORT: "3022",
      TOKEN: "ab c",
    });
  });
  it("ignores blanks/comments and a leading UTF-8 BOM", () => {
    expect(parseEnvFile("﻿# c\n\nSTOA_TRUST_TAILSCALE=1\n")).toEqual({
      STOA_TRUST_TAILSCALE: "1",
    });
  });
  it("skips malformed keys / lines without =", () => {
    expect(parseEnvFile("123BAD=x\nnoequals\nOK=1")).toEqual({ OK: "1" });
  });
});

describe("load-env: loadEnvFile (real env wins, no clobber)", () => {
  const tmps: string[] = [];
  const saved = { ...process.env };
  const fresh = () => {
    const d = mkdtempSync(join(tmpdir(), "stoa-loadenv-"));
    tmps.push(d);
    return d;
  };
  beforeEach(() => {
    delete process.env.STOA_SKIP_ENV_FILE;
    delete process.env.LE_TEST_A;
    delete process.env.LE_TEST_B;
  });
  afterEach(() => {
    for (const k of Object.keys(process.env))
      if (!(k in saved)) delete (process.env as Record<string, string>)[k];
    Object.assign(process.env, saved);
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("is a silent no-op when no .env exists", () => {
    expect(loadEnvFile(fresh())).toEqual({});
  });
  it("sets unset keys but never clobbers a value already in the environment", () => {
    const dir = fresh();
    writeFileSync(
      join(dir, ".env"),
      "LE_TEST_A=fromfile\nLE_TEST_B=fromfile\n"
    );
    process.env.LE_TEST_A = "fromenv"; // real env present
    loadEnvFile(dir);
    expect(process.env.LE_TEST_A).toBe("fromenv"); // not clobbered
    expect(process.env.LE_TEST_B).toBe("fromfile"); // filled
  });
  it("respects STOA_SKIP_ENV_FILE=1", () => {
    const dir = fresh();
    writeFileSync(join(dir, ".env"), "LE_TEST_A=x\n");
    process.env.STOA_SKIP_ENV_FILE = "1";
    expect(loadEnvFile(dir)).toEqual({});
    expect(process.env.LE_TEST_A).toBeUndefined();
  });
});
