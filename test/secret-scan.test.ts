/**
 * Secrets guard (#36) — locks the pure NAME matcher matrix (lib/secret-scan)
 * and the /api/secret-scan route contract: sandboxed (roots + home tree, 403
 * outside), ONE shallow readdir (nested secrets invisible), names only, and
 * advisory (a missing/non-directory path is an empty result, never an error).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { NextRequest } from "next/server";
import { createSchema } from "../lib/db/schema";
import { runMigrations } from "../lib/db/migrations";
import { classifySecretFiles, MAX_SECRET_FINDINGS } from "../lib/secret-scan";

// The route needs the db for getAllowedPathRoots — same holder seam as
// session-cost-route.test.ts (getDb is swapped; queries stay real).
const holder = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => holder.db };
});

import { GET } from "@/app/api/secret-scan/route";
import { queries } from "@/lib/db";

describe("classifySecretFiles — name matcher matrix", () => {
  const cases: Array<[string, boolean]> = [
    [".env", true],
    [".env.local", true],
    [".env.production", true],
    ["x.pem", true],
    ["server.pem", true],
    ["id_rsa", true],
    ["id_ed25519", true],
    ["credentials.json", true],
    [".npmrc", true], // name match only — contents are never read
    // non-matches
    ["env.ts", false],
    ["README.md", false],
    ["package.json", false],
    [".environment", false],
    ["id_rsa.pub", false], // public half of the keypair — not a secret
    ["id_ed25519.pub", false],
    ["credentials.json.bak", false],
    ["pem", false],
    // Documented decision: .envrc is direnv CODE (layout/use directives), not a
    // dotenv secrets file — matching it would warn on every direnv-using repo.
    [".envrc", false],
  ];
  for (const [name, expected] of cases) {
    it(`${expected ? "matches" : "ignores"} ${name}`, () => {
      expect(classifySecretFiles([name])).toEqual(expected ? [name] : []);
    });
  }

  it("matches case-insensitively (Windows/macOS filesystems) but returns ORIGINAL names", () => {
    expect(classifySecretFiles(["ID_RSA", "Credentials.JSON", ".ENV"])).toEqual(
      [".ENV", "Credentials.JSON", "ID_RSA"]
    );
  });

  it("orders results alphabetically regardless of input order", () => {
    expect(classifySecretFiles(["id_rsa", ".npmrc", "b.pem", ".env"])).toEqual([
      ".env",
      ".npmrc",
      "b.pem",
      "id_rsa",
    ]);
  });

  it(`caps findings at ${MAX_SECRET_FINDINGS}`, () => {
    const names = Array.from(
      { length: 15 },
      (_, i) => `key-${String(i).padStart(2, "0")}.pem`
    );
    const out = classifySecretFiles(names);
    expect(out).toHaveLength(MAX_SECRET_FINDINGS);
    expect(out[0]).toBe("key-00.pem");
    expect(out[MAX_SECRET_FINDINGS - 1]).toBe("key-09.pem");
  });

  it("returns [] for empty input", () => {
    expect(classifySecretFiles([])).toEqual([]);
  });
});

// ── route ──

function req(params: Record<string, string>): NextRequest {
  const url = new URL("http://localhost/api/secret-scan");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // The handler only touches request.nextUrl.searchParams.
  return { nextUrl: url } as unknown as NextRequest;
}

let tmpRoot: string;

beforeAll(() => {
  const mem = new Database(":memory:");
  createSchema(mem);
  runMigrations(mem);
  holder.db = mem;

  // A real on-disk directory registered as a project root, so the sandbox
  // allows it on every OS (on Linux CI os.tmpdir() is NOT under home — the
  // registered-roots path is what admits it).
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stoa-secret-scan-"));
  queries
    .createProject(holder.db)
    .run("proj-scan", "SecretScan", tmpRoot, "claude", "sonnet", null, 0);

  for (const name of [
    ".env",
    ".env.local",
    "server.pem",
    "id_rsa",
    "credentials.json",
    ".npmrc",
    "README.md",
    "env.ts",
  ]) {
    fs.writeFileSync(path.join(tmpRoot, name), "x");
  }
  // A nested secret must stay INVISIBLE — the scan is one shallow readdir.
  fs.mkdirSync(path.join(tmpRoot, "nested"));
  fs.writeFileSync(path.join(tmpRoot, "nested", ".env"), "x");
});

afterAll(() => {
  holder.db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /api/secret-scan", () => {
  it("400s when no path is given", async () => {
    const res = await GET(req({}));
    expect(res.status).toBe(400);
  });

  it("403s a path outside the workspace roots and home tree", async () => {
    const res = await GET(req({ path: "/stoa-secret-scan-denied-xyz" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Path is outside the allowed workspace");
  });

  it("reports secret names (sorted) from ONE shallow readdir of an allowed dir", async () => {
    const res = await GET(req({ path: tmpRoot }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Alphabetical; README.md/env.ts filtered out; nested/.env NOT surfaced.
    expect(body.findings).toEqual([
      ".env",
      ".env.local",
      ".npmrc",
      "credentials.json",
      "id_rsa",
      "server.pem",
    ]);
  });

  it("200 with empty findings for a nonexistent dir under an allowed root", async () => {
    const res = await GET(req({ path: path.join(tmpRoot, "does-not-exist") }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.findings).toEqual([]);
  });

  it("200 with empty findings when the path is a FILE, not a directory", async () => {
    const res = await GET(req({ path: path.join(tmpRoot, "README.md") }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.findings).toEqual([]);
  });
});
