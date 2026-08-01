import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { queries } from "@/lib/db";
import { insertFleetArtifact } from "@/lib/fleet/durable-write";
import { readFleetArtifactBody } from "@/lib/fleet/artifact-read";
import type { FleetArtifactRow } from "@/lib/fleet/types";

function fixture() {
  const db = new Database(":memory:");
  createSchema(db);
  db.prepare(
    `INSERT INTO fleet_runs (id, name, goal)
     VALUES ('run-1', 'Fleet', 'Read bodies lazily')`
  ).run();
  insertFleetArtifact(db, {
    id: "artifact-1",
    runId: "run-1",
    artifactType: "worker_report",
    title: "Exact report",
    body: "bounded body",
    severity: "info",
    actor: "worker",
  });
  return db;
}

describe("Fleet artifact body reads", () => {
  it("keeps bodies out of run summaries and verifies an exact on-demand read", () => {
    const db = fixture();
    const summary = queries
      .listFleetArtifactsForRun(db)
      .all("run-1", 100) as FleetArtifactRow[];
    expect(summary).toHaveLength(1);
    expect(summary[0].body).toBe("");
    expect(summary[0].byte_count).toBe(Buffer.byteLength("bounded body"));

    expect(
      readFleetArtifactBody({ runId: "run-1", artifactId: "artifact-1" }, db)
    ).toMatchObject({
      ok: true,
      artifact: {
        id: "artifact-1",
        byteCount: Buffer.byteLength("bounded body"),
        body: "bounded body",
        bodyPrunedAt: null,
      },
    });
    db.close();
  });

  it("fails closed on corrupt evidence and returns only metadata after pruning", () => {
    const db = fixture();
    db.prepare(`UPDATE fleet_artifacts SET body = 'tampered' WHERE id = ?`).run(
      "artifact-1"
    );
    expect(
      readFleetArtifactBody({ runId: "run-1", artifactId: "artifact-1" }, db)
    ).toEqual({
      ok: false,
      error: "Fleet artifact body failed its integrity check",
      status: 409,
    });

    db.prepare(
      `UPDATE fleet_artifacts SET body = '', body_pruned_at = ? WHERE id = ?`
    ).run("2026-08-01T12:00:00.000Z", "artifact-1");
    expect(
      readFleetArtifactBody({ runId: "run-1", artifactId: "artifact-1" }, db)
    ).toMatchObject({
      ok: true,
      artifact: {
        body: "",
        bodyPrunedAt: "2026-08-01T12:00:00.000Z",
      },
    });
    db.close();
  });

  it("rejects invalid or cross-run bindings", () => {
    const db = fixture();
    expect(
      readFleetArtifactBody({ runId: "../run", artifactId: "artifact-1" }, db)
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      readFleetArtifactBody({ runId: "run-2", artifactId: "artifact-1" }, db)
    ).toMatchObject({ ok: false, status: 404 });
    db.close();
  });

  it("keeps pre-integrity-column artifacts readable with computed bindings", () => {
    const db = fixture();
    db.prepare(
      `UPDATE fleet_artifacts SET content_hash = NULL, byte_count = 0
       WHERE id = 'artifact-1'`
    ).run();
    expect(
      readFleetArtifactBody({ runId: "run-1", artifactId: "artifact-1" }, db)
    ).toMatchObject({
      ok: true,
      artifact: {
        byteCount: Buffer.byteLength("bounded body"),
        body: "bounded body",
      },
    });
    const result = readFleetArtifactBody(
      { runId: "run-1", artifactId: "artifact-1" },
      db
    );
    expect(result.ok && result.artifact.contentHash).toMatch(/^[a-f0-9]{64}$/);
    db.close();
  });
});
