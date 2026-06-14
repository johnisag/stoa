/**
 * spawnWorktreeWorker orphan-row cleanup — when the session backend create()
 * throws, the row inserted just before it must be reclaimed so dead sessions
 * don't accumulate. Uses a real in-memory SQLite DB and mocked I/O.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => state.db };
});

vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({
    create: async () => {
      throw new Error("backend create boom");
    },
  }),
}));

vi.mock("@/lib/model-catalog", () => ({
  resolveModelForAgent: () => "sonnet",
}));

vi.mock("@/lib/providers", () => ({
  getProvider: () => ({ id: "claude" }),
  buildAgentArgs: () => ({ binary: "claude", args: [] }),
  shellQuoteArg: (s: string) => s,
}));

vi.mock("@/lib/providers/registry", () => ({
  sessionKey: () => "claude-sess-key",
}));

vi.mock("@/lib/banner", () => ({
  wrapWithBanner: (s: string) => s,
}));

vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return { ...actual, expandHome: (p: string) => p, resolveBinary: () => "gh" };
});

import {
  spawnWorktreeWorker,
  type WorktreeSpawnTarget,
} from "@/lib/dispatch/reviewer";
import { queries } from "@/lib/db";

function db() {
  return state.db as InstanceType<typeof Database>;
}

const ids = () =>
  (queries.getAllSessions(db()).all() as { id: string }[]).map((r) => r.id);

beforeAll(() => {
  const d = new Database(":memory:");
  createSchema(d);
  runMigrations(d);
  state.db = d;
});

beforeEach(() => {
  db().exec("DELETE FROM sessions;");
});

describe("spawnWorktreeWorker", () => {
  it("deletes the inserted sessions row when backend create throws", async () => {
    const target: WorktreeSpawnTarget = {
      agentType: "claude",
      projectId: "uncategorized",
      baseBranch: "main",
      worktreePath: "/wt/test",
      branchName: "feature/test",
      label: "test#1",
    };
    const spawnedIds: string[] = [];
    const result = await spawnWorktreeWorker(
      target,
      "test-session",
      "prompt",
      (id) => spawnedIds.push(id)
    );

    expect(result).toBeNull();
    expect(spawnedIds).toHaveLength(1);
    expect(ids()).not.toContain(spawnedIds[0]);
  });
});
