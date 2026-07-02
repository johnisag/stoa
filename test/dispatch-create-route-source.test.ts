/**
 * #34 round-2 regression: POST /api/dispatch/issues/create must NOT run `gh`
 * against a non-github (Linear) repo. `createIssue` (which shells out to `gh
 * issue create --repo <slug>`) ran unconditionally before the source gate, so a
 * Linear repo + a GitHub-issue create would `gh … --repo linear:TEAM` and 500.
 * The route now rejects it with a 400 BEFORE createIssue — proven here by a
 * createIssue spy that must never be called for a Linear repo.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import type { NextRequest } from "next/server";
import { createSchema } from "../lib/db/schema";
import { runMigrations } from "../lib/db/migrations";

const holder = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => holder.db };
});

// The gh-spawning call — must never fire for a Linear repo.
const createIssueSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dispatch/create", () => ({
  createIssue: createIssueSpy,
}));

import { POST } from "@/app/api/dispatch/issues/create/route";
import { queries } from "@/lib/db";

function req(body: unknown): NextRequest {
  return {
    json: async () => body,
    headers: new Headers({ host: "localhost" }),
  } as unknown as NextRequest;
}

beforeAll(() => {
  const mem = new Database(":memory:");
  createSchema(mem);
  runMigrations(mem);
  holder.db = mem;
  // A Linear-tracked repo (linear: slug).
  queries
    .createDispatchRepo(holder.db)
    .run(
      "repo-linear",
      "/tmp/x",
      "linear:ENG",
      "claude",
      5,
      2,
      null,
      "main",
      "review",
      1,
      0,
      0,
      0,
      0,
      null,
      null
    );
});

afterAll(() => {
  holder.db.close();
});

describe("POST /api/dispatch/issues/create — source gating (#34)", () => {
  it("400s a GitHub-issue create for a Linear repo and NEVER spawns gh", async () => {
    createIssueSpy.mockClear();
    const res = await POST(
      req({
        repoId: "repo-linear",
        title: "Fix login",
        source: "github",
        disposition: "backlog",
      })
    );
    expect(res.status).toBe(400);
    // The gh-spawning path must not have run.
    expect(createIssueSpy).not.toHaveBeenCalled();
  });
});
