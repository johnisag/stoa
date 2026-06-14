/**
 * Saved workflows service: schema + queries round-trip over a real in-memory
 * SQLite (real schema + migrations + queries, getDb() mocked to point at it).
 * Locks create/list/get/update/delete, the BuilderDoc (incl. canvas positions)
 * JSON round-trip, ordering, and the corrupt-row fallback.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({ db: null as unknown }));
// Override BOTH getDb AND the `db` proxy: the service uses the `db` proxy, whose
// internal getDb() call is the module-local one (not the export), so mocking only
// getDb would leave the service writing to the real database. A live getter keeps
// `db` pointed at the in-memory instance created in beforeAll.
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    getDb: () => state.db,
    get db() {
      return state.db;
    },
  };
});

import {
  createSavedWorkflow,
  listSavedWorkflows,
  getSavedWorkflow,
  updateSavedWorkflow,
  deleteSavedWorkflow,
} from "@/lib/saved-workflows";
import type { BuilderDoc } from "@/lib/pipeline/builder-model";

function db() {
  return state.db as InstanceType<typeof Database>;
}

const doc = (over: Partial<BuilderDoc> = {}): BuilderDoc => ({
  name: "wf",
  workingDirectory: "/repo",
  nodes: [
    { step: { id: "a", agent: "claude", task: "do a" }, x: 16, y: 16 },
    {
      step: { id: "b", agent: "claude", task: "do b", dependsOn: ["a"] },
      x: 226,
      y: 16,
    },
  ],
  ...over,
});

beforeAll(() => {
  const d = new Database(":memory:");
  createSchema(d);
  runMigrations(d);
  state.db = d;
});

beforeEach(() => {
  db().exec("DELETE FROM saved_workflows;");
});

describe("saved-workflows service", () => {
  it("creates and reads back a workflow with its doc + positions intact", () => {
    const created = createSavedWorkflow({ name: "My flow", doc: doc() });
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("My flow");
    expect(created.createdAt).toBeTruthy();

    const got = getSavedWorkflow(created.id);
    expect(got?.doc.nodes).toHaveLength(2);
    expect(got?.doc.nodes[1]).toMatchObject({ x: 226, y: 16 });
    expect(got?.doc.nodes[1].step.dependsOn).toEqual(["a"]);
  });

  it("lists newest-first", () => {
    const first = createSavedWorkflow({ name: "first", doc: doc() });
    // Bump updated_at so ordering is deterministic regardless of insert timing.
    db()
      .prepare(
        `UPDATE saved_workflows SET updated_at = datetime('now','-1 hour') WHERE id = ?`
      )
      .run(first.id);
    const second = createSavedWorkflow({ name: "second", doc: doc() });
    expect(listSavedWorkflows().map((w) => w.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it("updates name + doc", () => {
    const created = createSavedWorkflow({ name: "old", doc: doc() });
    const updated = updateSavedWorkflow(created.id, {
      name: "new",
      doc: doc({ nodes: [] }),
    });
    expect(updated?.name).toBe("new");
    expect(updated?.doc.nodes).toHaveLength(0);
    expect(getSavedWorkflow(created.id)?.name).toBe("new");
  });

  it("update returns undefined for a missing id", () => {
    expect(
      updateSavedWorkflow("ghost", { name: "x", doc: doc() })
    ).toBeUndefined();
  });

  it("deletes and reports whether a row was removed", () => {
    const created = createSavedWorkflow({ name: "tmp", doc: doc() });
    expect(deleteSavedWorkflow(created.id)).toBe(true);
    expect(getSavedWorkflow(created.id)).toBeUndefined();
    expect(deleteSavedWorkflow(created.id)).toBe(false);
  });

  it("falls back to an empty doc (keeping the name) on a corrupt row", () => {
    db()
      .prepare(
        `INSERT INTO saved_workflows (id, name, builder_doc) VALUES (?, ?, ?)`
      )
      .run("corrupt", "Broken", "{ not json");
    const got = getSavedWorkflow("corrupt");
    expect(got?.name).toBe("Broken");
    expect(got?.doc.nodes).toEqual([]);
  });
});
