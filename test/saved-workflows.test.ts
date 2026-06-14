/**
 * Saved workflows service: schema + queries round-trip over a real in-memory
 * SQLite (real schema + migrations + queries, getDb() mocked to point at it).
 * Locks create/list/get/update/delete, the BuilderDoc (incl. canvas positions)
 * JSON round-trip, ordering, history snapshots, and the corrupt-row fallback.
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
  notes: [],
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
  it("creates a workflow with an empty history", () => {
    const created = createSavedWorkflow({ name: "fresh", doc: doc() });
    expect(created.history).toEqual([]);
    expect(getSavedWorkflow(created.id)?.history).toEqual([]);
  });

  it("appends a history snapshot on update", () => {
    const created = createSavedWorkflow({
      name: "v1",
      doc: doc({ name: "v1" }),
    });
    const updated = updateSavedWorkflow(created.id, {
      name: "v2",
      doc: doc({ name: "v2" }),
    });
    expect(updated?.history).toHaveLength(1);
    expect(updated?.history[0].doc.name).toBe("v1");
    // Snapshot is labelled with the shape it captured (default doc = 2 steps).
    expect(updated?.history[0].name).toBe("2 steps");
    expect(updated?.history[0].id).toBeTruthy();
    expect(updated?.history[0].createdAt).toBeTruthy();

    const updated2 = updateSavedWorkflow(created.id, {
      name: "v3",
      doc: doc({ name: "v3" }),
    });
    expect(updated2?.history).toHaveLength(2);
    expect(updated2?.history[0].doc.name).toBe("v2");
    expect(updated2?.history[1].doc.name).toBe("v1");
  });

  it("caps history at 10 snapshots (newest first)", () => {
    const created = createSavedWorkflow({
      name: "base",
      doc: doc({ name: "base" }),
    });
    for (let i = 1; i <= 11; i++) {
      updateSavedWorkflow(created.id, {
        name: `v${i}`,
        doc: doc({ name: `v${i}` }),
      });
    }
    const got = getSavedWorkflow(created.id);
    expect(got?.history).toHaveLength(10);
    // 11 updates produce snapshots of v10 down to v1 (the base doc is evicted).
    expect(got?.history[0].doc.name).toBe("v10");
    expect(got?.history[9].doc.name).toBe("v1");
  });

  it("tolerates corrupt history JSON and falls back to an empty history", () => {
    const created = createSavedWorkflow({ name: "clean", doc: doc() });
    db()
      .prepare(`UPDATE saved_workflows SET history = ? WHERE id = ?`)
      .run("{ not json", created.id);
    const got = getSavedWorkflow(created.id);
    expect(got?.history).toEqual([]);
  });

  it("tolerates a malformed history entry and falls back to an empty history", () => {
    const created = createSavedWorkflow({ name: "clean", doc: doc() });
    db()
      .prepare(`UPDATE saved_workflows SET history = ? WHERE id = ?`)
      .run(
        JSON.stringify([
          { id: "only-id", name: 123, createdAt: "now", doc: doc() },
        ]),
        created.id
      );
    const got = getSavedWorkflow(created.id);
    expect(got?.history).toEqual([]);
  });

  it("labels a history snapshot with its step (and note) count", () => {
    const created = createSavedWorkflow({
      name: "v1",
      doc: doc({
        name: "v1",
        nodes: [{ step: { id: "a", agent: "claude", task: "t" }, x: 0, y: 0 }],
        notes: [{ id: "n1", text: "hi", x: 0, y: 0 }],
      }),
    });
    const updated = updateSavedWorkflow(created.id, {
      name: "v2",
      doc: doc({ name: "v2" }),
    });
    expect(updated?.history[0].name).toBe("1 step, 1 note");
  });

  it("tolerates a valid-JSON non-array history and falls back to empty", () => {
    const created = createSavedWorkflow({ name: "clean", doc: doc() });
    db()
      .prepare(`UPDATE saved_workflows SET history = ? WHERE id = ?`)
      .run(JSON.stringify({ not: "an array" }), created.id);
    expect(getSavedWorkflow(created.id)?.history).toEqual([]);
  });
});
