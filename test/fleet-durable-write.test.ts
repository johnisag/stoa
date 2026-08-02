import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import {
  FleetRuntimeQuotaExceededError,
  insertFleetArtifact,
  insertFleetEvent,
} from "@/lib/fleet/durable-write";

function database(limits: Record<string, number>) {
  const db = new Database(":memory:");
  createSchema(db);
  db.prepare(
    `INSERT INTO fleet_runs (id, name, goal, resource_limits_json)
     VALUES ('run-1', 'Fleet', 'Goal', ?)`
  ).run(JSON.stringify(limits));
  return db;
}

describe("Fleet durable writes", () => {
  it("redacts event payloads, preserves structured hashes, and meters fanout", () => {
    const db = database({ eventFanoutPerMinute: 1 });
    const createdAt = "2026-08-01T12:00:00.000Z";
    insertFleetEvent(db, {
      runId: "run-1",
      eventType: "worker_notice",
      actor: "worker-api_key=abcdefghijklmnop",
      payload: JSON.stringify({
        message: "api_key=abcdefghijklmnop",
        headSha: "0123456789abcdef0123456789abcdef01234567",
      }),
      createdAt,
    });
    const event = db
      .prepare(`SELECT actor, payload FROM fleet_events`)
      .get() as {
      actor: string;
      payload: string;
    };
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    expect(event.actor).toBe("worker-api_key=[REDACTED]");
    expect(payload.message).toBe("api_key=[REDACTED]");
    expect(payload.headSha).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(payload.fleetRedaction).toEqual({ replacementCount: 1 });
    expect(() =>
      insertFleetEvent(db, {
        runId: "run-1",
        eventType: "second_notice",
        actor: "worker",
        payload: null,
        createdAt,
      })
    ).toThrow(FleetRuntimeQuotaExceededError);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM fleet_events`).get()).toEqual({
      n: 1,
    });
    expect(
      db
        .prepare(
          `SELECT units FROM fleet_resource_usage_buckets
           WHERE resource_type = 'event_fanout_per_minute'`
        )
        .get()
    ).toEqual({ units: 1 });
  });

  it("meters accumulated event bytes atomically with fanout", () => {
    const db = database({
      eventFanoutPerMinute: 10,
      eventBytesPerMinute: 40,
    });
    const createdAt = "2026-08-01T12:00:00.000Z";
    insertFleetEvent(db, {
      runId: "run-1",
      eventType: "first",
      actor: "worker",
      payload: "12345678901234567890",
      createdAt,
    });
    expect(() =>
      insertFleetEvent(db, {
        runId: "run-1",
        eventType: "second",
        actor: "worker",
        payload: "123456789012345678901",
        createdAt,
      })
    ).toThrow(FleetRuntimeQuotaExceededError);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM fleet_events`).get()).toEqual({
      n: 1,
    });
    expect(
      db
        .prepare(
          `SELECT resource_type, units FROM fleet_resource_usage_buckets
           WHERE resource_type IN ('event_bytes_per_minute', 'event_fanout_per_minute')
           ORDER BY resource_type`
        )
        .all()
    ).toEqual([
      { resource_type: "event_bytes_per_minute", units: 31 },
      { resource_type: "event_fanout_per_minute", units: 1 },
    ]);
  });

  it("redacts artifact fields without changing evidence hashes", () => {
    const db = database({ artifactBytesPerMinute: 4096 });
    insertFleetArtifact(db, {
      id: "artifact-1",
      runId: "run-1",
      contentHash:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      metadataJson: JSON.stringify({ note: "password=hunter22" }),
      artifactType: "worker_report",
      title: "Report api_key=abcdefghijklmnop",
      body: "Bearer abcdefghijklmnopqrstuvwxyz",
      severity: "info",
      actor: "worker-password=hunter22",
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    const row = db.prepare(`SELECT * FROM fleet_artifacts`).get() as {
      title: string;
      body: string;
      content_hash: string;
      metadata_json: string;
      actor: string;
    };
    expect(`${row.title} ${row.body} ${row.metadata_json}`).not.toContain(
      "abcdefghijklmnop"
    );
    expect(row.content_hash).toBe(
      createHash("sha256").update(row.body, "utf8").digest("hex")
    );
    expect(JSON.parse(row.metadata_json).fleetRedaction).toEqual({
      replacementCount: 4,
    });
    expect(row.actor).toBe("worker-password=[REDACTED]");
  });

  it("omits oversized event input and rejects oversized artifacts before persistence", () => {
    const db = database({
      eventFanoutPerMinute: 10,
      eventBytesPerMinute: 1_000,
      artifactBytesPerMinute: 10_000_000,
    });
    insertFleetEvent(db, {
      runId: "run-1",
      eventType: "oversized_event",
      actor: "worker",
      payload: `api_key=abcdefghijklmnop${"x".repeat(70 * 1024)}`,
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    const payload = JSON.parse(
      (
        db.prepare(`SELECT payload FROM fleet_events`).get() as {
          payload: string;
        }
      ).payload
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      omitted: true,
      reason: "payload_too_large",
    });
    expect(JSON.stringify(payload)).not.toContain("abcdefghijklmnop");

    expect(() =>
      insertFleetArtifact(db, {
        id: "artifact-oversized-input",
        runId: "run-1",
        artifactType: "worker_report",
        title: "Report",
        body: "x".repeat(4 * 1024 * 1024 + 1),
        severity: "info",
        actor: "worker",
        createdAt: "2026-08-01T12:00:00.000Z",
      })
    ).toThrow(/exceeds 4194304 bytes/);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_artifacts`).get()
    ).toEqual({ n: 0 });
  });

  it("rolls back an over-limit artifact charge and durable row atomically", () => {
    const db = database({ artifactBytesPerMinute: 20 });
    expect(() =>
      insertFleetArtifact(db, {
        id: "artifact-too-large",
        runId: "run-1",
        artifactType: "worker_report",
        title: "Report",
        body: "This body exceeds the configured limit",
        severity: "info",
        actor: "worker",
        createdAt: "2026-08-01T12:00:00.000Z",
      })
    ).toThrow(FleetRuntimeQuotaExceededError);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_artifacts`).get()
    ).toEqual({ n: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_resource_usage_buckets`).get()
    ).toEqual({ n: 0 });
  });

  it("enforces cumulative per-run storage limits across minute windows", () => {
    const db = database({
      eventFanoutPerMinute: 10,
      eventBytesPerMinute: 1_000,
      eventBytesTotal: 35,
      artifactBytesPerMinute: 1_000,
      artifactBytesTotal: 40,
    });
    insertFleetEvent(db, {
      runId: "run-1",
      eventType: "a",
      actor: "b",
      payload: "12345678901234567890",
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    expect(() =>
      insertFleetEvent(db, {
        runId: "run-1",
        eventType: "a",
        actor: "b",
        payload: "12345678901234",
        createdAt: "2026-08-01T12:01:00.000Z",
      })
    ).toThrow(FleetRuntimeQuotaExceededError);

    insertFleetArtifact(db, {
      id: "artifact-total-1",
      runId: "run-1",
      artifactType: "worker_report",
      title: "A",
      body: "1234567890",
      severity: "info",
      actor: "worker",
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    expect(() =>
      insertFleetArtifact(db, {
        id: "artifact-total-2",
        runId: "run-1",
        artifactType: "worker_report",
        title: "B",
        body: "x".repeat(30),
        severity: "info",
        actor: "worker",
        createdAt: "2026-08-01T12:01:00.000Z",
      })
    ).toThrow(FleetRuntimeQuotaExceededError);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM fleet_events`).get()).toEqual({
      n: 1,
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_artifacts`).get()
    ).toEqual({ n: 1 });
  });

  it("reserves a bounded allowlist for safety-critical control-plane events", () => {
    const db = database({
      eventFanoutPerMinute: 1,
      eventBytesPerMinute: 1,
      eventBytesTotal: 1,
    });
    insertFleetEvent(db, {
      runId: "run-1",
      eventType: "worker_started",
      actor: "scheduler",
      payload: JSON.stringify({ workerId: "worker-1" }),
      controlPlane: true,
    });
    insertFleetEvent(db, {
      runId: "run-1",
      eventType: "auxiliary_interrupt_stop_confirmed",
      actor: "scheduler",
      payload: JSON.stringify({ accountId: "account-1" }),
      controlPlane: true,
    });
    expect(() =>
      insertFleetEvent(db, {
        runId: "run-1",
        eventType: "ordinary_event",
        actor: "scheduler",
        payload: null,
      })
    ).toThrow(FleetRuntimeQuotaExceededError);
    expect(() =>
      insertFleetEvent(db, {
        runId: "run-1",
        eventType: "ordinary_event",
        actor: "scheduler",
        payload: null,
        controlPlane: true,
      })
    ).toThrow(/not allowlisted/);
    expect(() =>
      insertFleetEvent(db, {
        runId: "run-1",
        eventType: "cleanup_action_untrusted",
        actor: "scheduler",
        payload: null,
        controlPlane: true,
      })
    ).toThrow(/not allowlisted/);
    expect(db.prepare(`SELECT event_type FROM fleet_events`).all()).toEqual([
      { event_type: "worker_started" },
      { event_type: "auxiliary_interrupt_stop_confirmed" },
    ]);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_resource_usage_buckets`).get()
    ).toEqual({ n: 0 });
  });

  it("keeps exact archive and cleanup audit events writable at exhausted quota", () => {
    const db = database({
      eventFanoutPerMinute: 1,
      eventBytesPerMinute: 1,
      eventBytesTotal: 1,
    });
    const eventTypes = [
      "run_archived",
      "cleanup_requested",
      "cleanup_action_completed",
      "cleanup_action_failed",
      "cleanup_action_skipped",
    ];
    for (const eventType of eventTypes) {
      insertFleetEvent(db, {
        runId: "run-1",
        eventType,
        actor: "fleet-lifecycle",
        payload: null,
        controlPlane: true,
      });
    }

    expect(
      db.prepare(`SELECT event_type FROM fleet_events ORDER BY id`).all()
    ).toEqual(eventTypes.map((event_type) => ({ event_type })));
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_resource_usage_buckets`).get()
    ).toEqual({ n: 0 });
  });
});
