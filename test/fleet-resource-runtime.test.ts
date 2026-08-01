import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import {
  acquireFleetRuntimeResources,
  chargeFleetRuntimeUsage,
  fleetWorkerResourceRequest,
  looksLikeProviderRateLimit,
  recordFleetProviderCooldown,
  releaseFleetRuntimeResources,
} from "@/lib/fleet/resource-runtime";
import { normalizeFleetResourceLimits } from "@/lib/fleet/resource-admission";

function database() {
  const db = new Database(":memory:");
  createSchema(db);
  db.prepare(
    `INSERT INTO fleet_runs (id, name, goal) VALUES ('run-1', 'Fleet', 'Goal')`
  ).run();
  return db;
}

describe("Fleet durable resource admission", () => {
  it("charges actual minute usage atomically and rejects over-limit bytes", () => {
    const db = database();
    db.prepare(
      `UPDATE fleet_runs SET resource_limits_json = ? WHERE id = 'run-1'`
    ).run(JSON.stringify({ outputBytesPerMinute: 10 }));
    const now = new Date("2026-08-01T12:00:00.000Z");
    expect(
      chargeFleetRuntimeUsage(db, {
        runId: "run-1",
        kind: "output_bytes_per_minute",
        units: 6,
        now,
      })
    ).toMatchObject({ admitted: true });
    expect(
      chargeFleetRuntimeUsage(db, {
        runId: "run-1",
        kind: "output_bytes_per_minute",
        units: 5,
        now,
      })
    ).toMatchObject({ admitted: false });
    expect(
      db
        .prepare(
          `SELECT units FROM fleet_resource_usage_buckets
           WHERE resource_type = 'output_bytes_per_minute'`
        )
        .get()
    ).toEqual({ units: 6 });
  });

  it("isolates both per-run usage and per-run lease caps", () => {
    const db = database();
    db.prepare(
      `INSERT INTO fleet_runs (id, name, goal, resource_limits_json)
       VALUES ('run-2', 'Other Fleet', 'Goal', ?)`
    ).run(JSON.stringify({ outputBytesPerMinute: 5 }));
    db.prepare(
      `UPDATE fleet_runs SET resource_limits_json = ? WHERE id = 'run-1'`
    ).run(JSON.stringify({ outputBytesPerMinute: 6 }));
    const now = new Date("2026-08-01T12:00:00.000Z");

    expect(
      chargeFleetRuntimeUsage(db, {
        runId: "run-1",
        kind: "output_bytes_per_minute",
        units: 6,
        now,
      })
    ).toMatchObject({ admitted: true });
    expect(
      chargeFleetRuntimeUsage(db, {
        runId: "run-2",
        kind: "output_bytes_per_minute",
        units: 5,
        now,
      })
    ).toMatchObject({ admitted: true });
    expect(
      db
        .prepare(
          `SELECT fleet_run_id, units FROM fleet_resource_usage_buckets
           ORDER BY fleet_run_id`
        )
        .all()
    ).toEqual([
      { fleet_run_id: "run-1", units: 6 },
      { fleet_run_id: "run-2", units: 5 },
    ]);

    const hostLimits = normalizeFleetResourceLimits({ pty: 1 });
    expect(
      acquireFleetRuntimeResources(db, {
        runId: "run-1",
        ownerType: "worker",
        ownerId: "worker-host-1",
        resources: [{ kind: "pty", key: "local", units: 1 }],
        limits: hostLimits,
        now,
      })
    ).toMatchObject({ admitted: true });
    expect(
      acquireFleetRuntimeResources(db, {
        runId: "run-2",
        ownerType: "worker",
        ownerId: "worker-host-2",
        resources: [{ kind: "pty", key: "local", units: 1 }],
        limits: hostLimits,
        now,
      })
    ).toMatchObject({ admitted: true });
    expect(
      acquireFleetRuntimeResources(db, {
        runId: "run-2",
        ownerType: "worker",
        ownerId: "worker-host-3",
        resources: [{ kind: "pty", key: "local", units: 1 }],
        limits: hostLimits,
        now,
      })
    ).toMatchObject({
      admitted: false,
      blocked: [{ kind: "pty", capacity: 1, used: 1, requested: 1 }],
    });
  });

  it("enforces stable host capacity independently of asymmetric run limits", () => {
    const db = database();
    db.prepare(
      `INSERT INTO fleet_runs (id, name, goal)
       VALUES ('run-2', 'Other Fleet', 'Goal'),
              ('run-3', 'Third Fleet', 'Goal')`
    ).run();
    const now = new Date("2026-08-01T12:00:00.000Z");
    expect(
      acquireFleetRuntimeResources(db, {
        runId: "run-1",
        ownerType: "worker",
        ownerId: "small-run-worker",
        resources: [{ kind: "pty", key: "local", units: 1 }],
        limits: normalizeFleetResourceLimits({ pty: 1 }),
        now,
      })
    ).toMatchObject({ admitted: true });
    expect(
      acquireFleetRuntimeResources(db, {
        runId: "run-2",
        ownerType: "worker",
        ownerId: "large-run-wave",
        resources: [{ kind: "pty", key: "local", units: 4 }],
        limits: normalizeFleetResourceLimits({ pty: 4 }),
        now,
      })
    ).toMatchObject({ admitted: true });

    // The low cap belongs only to run-1, while the process-wide default of six
    // remains authoritative even when run-3 requests a much larger local cap.
    expect(
      acquireFleetRuntimeResources(db, {
        runId: "run-3",
        ownerType: "worker",
        ownerId: "oversized-run-wave",
        resources: [{ kind: "pty", key: "local", units: 2 }],
        limits: normalizeFleetResourceLimits({ pty: 40 }),
        now,
      })
    ).toMatchObject({
      admitted: false,
      blocked: [{ kind: "pty", capacity: 6, used: 5, requested: 2 }],
    });
    expect(
      acquireFleetRuntimeResources(db, {
        runId: "run-2",
        ownerType: "worker",
        ownerId: "large-run-over-cap",
        resources: [{ kind: "pty", key: "local", units: 1 }],
        limits: normalizeFleetResourceLimits({ pty: 4 }),
        now,
      })
    ).toMatchObject({
      admitted: false,
      blocked: [{ kind: "pty", capacity: 4, used: 4, requested: 1 }],
    });
  });

  it("admits forty preserved task worktrees in bounded active waves", () => {
    const db = database();
    const limits = normalizeFleetResourceLimits({});
    const now = new Date("2026-08-01T12:00:00.000Z");
    const retainedWorkerIds: string[] = [];

    for (let waveStart = 0; waveStart < 40; waveStart += 6) {
      const waveSize = Math.min(6, 40 - waveStart);
      const activeWorkerIds: string[] = [];
      for (let offset = 0; offset < waveSize; offset++) {
        const workerId = `worker-${waveStart + offset + 1}`;
        const admitted = acquireFleetRuntimeResources(db, {
          runId: "run-1",
          ownerType: "worker",
          ownerId: workerId,
          resources: fleetWorkerResourceRequest({
            provider: "codex",
            repositoryKey: "repo-1",
          }),
          limits,
          now,
        });
        expect(admitted).toMatchObject({ admitted: true });
        activeWorkerIds.push(workerId);
        retainedWorkerIds.push(workerId);
      }

      if (waveStart === 0) {
        expect(
          acquireFleetRuntimeResources(db, {
            runId: "run-1",
            ownerType: "worker",
            ownerId: "seventh-active-worker",
            resources: fleetWorkerResourceRequest({
              provider: "codex",
              repositoryKey: "repo-1",
            }),
            limits,
            now,
          })
        ).toMatchObject({
          admitted: false,
          blocked: expect.arrayContaining([
            expect.objectContaining({ kind: "pty", capacity: 6, used: 6 }),
          ]),
        });
      }

      // A completed task keeps its real worktree and disk reservation until
      // explicit archived-run cleanup, but active paid-session resources return
      // to the next wave.
      for (const workerId of activeWorkerIds) {
        releaseFleetRuntimeResources(db, {
          ownerType: "worker",
          ownerId: workerId,
          now,
          preserveResourceTypes: ["repo_worktree", "disk_bytes"],
        });
      }
    }

    expect(retainedWorkerIds).toHaveLength(40);
    expect(
      db
        .prepare(
          `SELECT resource_type, COUNT(*) AS lease_count, SUM(units) AS units
           FROM fleet_runtime_leases WHERE status = 'reserved'
           GROUP BY resource_type ORDER BY resource_type`
        )
        .all()
    ).toEqual([
      {
        resource_type: "disk_bytes",
        lease_count: 40,
        units: 40 * 512 * 1024 ** 2,
      },
      { resource_type: "repo_worktree", lease_count: 40, units: 40 },
    ]);

    expect(
      acquireFleetRuntimeResources(db, {
        runId: "run-1",
        ownerType: "worker",
        ownerId: "worker-41",
        resources: fleetWorkerResourceRequest({
          provider: "codex",
          repositoryKey: "repo-1",
        }),
        limits,
        now,
      })
    ).toMatchObject({
      admitted: false,
      blocked: [
        expect.objectContaining({
          kind: "repo_worktree",
          capacity: 40,
          used: 40,
          requested: 1,
        }),
      ],
    });

    // Transient headroom remains available for the one integration worktree;
    // the 20 GiB retained estimate continues to count toward the 32 GiB limit.
    expect(
      acquireFleetRuntimeResources(db, {
        runId: "run-1",
        ownerType: "integration_workspace",
        ownerId: "run-1",
        resources: [
          { kind: "repo_worktree", key: "repo-1", units: 1 },
          { kind: "disk_bytes", key: "fleet", units: 512 * 1024 ** 2 },
        ],
        limits,
        now,
      })
    ).toMatchObject({ admitted: true });
  });

  it("canonicalizes and aggregates duplicate requests before writing leases", () => {
    const db = database();
    const limits = normalizeFleetResourceLimits({
      providerCaps: { codex: 2 },
      eventFanoutPerMinute: 3,
    });
    expect(
      acquireFleetRuntimeResources(db, {
        runId: "run-1",
        ownerType: "worker",
        ownerId: "worker-1",
        resources: [
          { kind: "provider", key: " Codex ", units: 1 },
          { kind: "provider", key: "codex", units: 1 },
          { kind: "event_fanout_per_minute", key: "fleet", units: 1 },
          { kind: "event_fanout_per_minute", key: "fleet", units: 1 },
        ],
        limits,
        now: new Date("2026-08-01T12:00:00.000Z"),
      })
    ).toMatchObject({ admitted: true });
    expect(
      db
        .prepare(
          `SELECT resource_key, units FROM fleet_runtime_leases
           WHERE resource_type = 'provider'`
        )
        .get()
    ).toEqual({ resource_key: "codex", units: 2 });
    expect(
      db.prepare(`SELECT units FROM fleet_resource_usage_buckets`).get()
    ).toEqual({ units: 2 });
  });

  it("acquires all resources atomically and denial writes nothing", () => {
    const db = database();
    const limits = normalizeFleetResourceLimits({
      pty: 1,
      providerCaps: { codex: 1 },
    });
    const resources = [
      { kind: "pty" as const, key: "local", units: 1 },
      { kind: "provider" as const, key: "codex", units: 1 },
      {
        kind: "event_fanout_per_minute" as const,
        key: "fleet",
        units: 1,
      },
    ];
    expect(
      acquireFleetRuntimeResources(db, {
        runId: "run-1",
        ownerType: "worker",
        ownerId: "worker-1",
        resources,
        limits,
        now: new Date("2026-08-01T12:00:00.000Z"),
      })
    ).toMatchObject({ admitted: true });
    expect(
      acquireFleetRuntimeResources(db, {
        runId: "run-1",
        ownerType: "worker",
        ownerId: "worker-2",
        resources,
        limits,
        now: new Date("2026-08-01T12:00:01.000Z"),
      })
    ).toMatchObject({ admitted: false });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_runtime_leases`).get()
    ).toEqual({ n: 2 });
    expect(
      db.prepare(`SELECT units FROM fleet_resource_usage_buckets`).get()
    ).toEqual({ units: 1 });
  });

  it("releases selected leases and recovers expired leases", () => {
    const db = database();
    const limits = normalizeFleetResourceLimits({ gitOperation: 1 });
    const resources = [
      { kind: "git_operation" as const, key: "repo-1", units: 1 },
      { kind: "repo_worktree" as const, key: "repo-1", units: 1 },
    ];
    acquireFleetRuntimeResources(db, {
      runId: "run-1",
      ownerType: "worker",
      ownerId: "worker-1",
      resources,
      limits,
      now: new Date("2026-08-01T12:00:00.000Z"),
      leaseExpiresAt: "2026-08-01T12:00:05.000Z",
    });
    expect(
      acquireFleetRuntimeResources(db, {
        runId: "run-1",
        ownerType: "worker",
        ownerId: "worker-2",
        resources,
        limits,
        now: new Date("2026-08-01T12:00:06.000Z"),
      })
    ).toMatchObject({ admitted: true });
    expect(
      releaseFleetRuntimeResources(db, {
        ownerType: "worker",
        ownerId: "worker-2",
        now: new Date("2026-08-01T12:00:07.000Z"),
        resourceTypes: ["git_operation"],
      })
    ).toBe(1);
  });

  it("persists provider cooldown and returns its retry time", () => {
    const db = database();
    const now = new Date("2026-08-01T12:00:00.000Z");
    const retryAt = recordFleetProviderCooldown(db, {
      provider: "Codex",
      reason: "HTTP 429",
      now,
    });
    expect(retryAt).toBe("2026-08-01T12:00:05.000Z");
    expect(
      acquireFleetRuntimeResources(db, {
        runId: "run-1",
        ownerType: "worker",
        ownerId: "worker-1",
        resources: [{ kind: "provider", key: "codex", units: 1 }],
        limits: normalizeFleetResourceLimits({}),
        now,
      })
    ).toMatchObject({ admitted: false, retryAt });
    expect(
      looksLikeProviderRateLimit(new Error("Too many requests (429)"))
    ).toBe(true);
    recordFleetProviderCooldown(db, {
      provider: "Hermes",
      reason: `HTTP 429 api_key=${"s".repeat(300)}`,
      now,
    });
    const cooldown = db
      .prepare(
        `SELECT reason FROM fleet_provider_cooldowns WHERE provider = 'hermes'`
      )
      .get() as { reason: string };
    expect(cooldown.reason).toContain("[REDACTED]");
    expect(cooldown.reason).not.toContain("ssss");
  });
});
