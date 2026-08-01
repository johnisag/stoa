import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  captureFleetWorkerOutput,
  FLEET_WORKER_OUTPUT_MAX_CHARS,
} from "@/lib/fleet/worker-output";
import type { chargeFleetRuntimeUsage } from "@/lib/fleet/resource-runtime";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      tmux_name TEXT,
      agent_type TEXT
    );
    CREATE TABLE fleet_workers (
      id TEXT PRIMARY KEY,
      fleet_run_id TEXT NOT NULL,
      task_id TEXT,
      session_id TEXT,
      status TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      attempt INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_heartbeat_at TEXT,
      ended_at TEXT
    );
    INSERT INTO sessions (id, tmux_name, agent_type)
      VALUES ('session-1', 'hermes-exact-worker', 'hermes');
    INSERT INTO fleet_workers
      (id, fleet_run_id, session_id, status, attempt, created_at)
      VALUES ('worker-1', 'run-1', 'session-1', 'running', 2,
              '2026-08-01T00:00:00.000Z');
  `);
  const backend = {
    exists: vi.fn(async () => true),
    capture: vi.fn(async () => "old\r\nrendered\u0000\nlatest"),
  };
  const chargeUsage = vi.fn<typeof chargeFleetRuntimeUsage>(() => ({
    admitted: true,
    leaseIds: [],
    bucketStartMs: Date.parse("2026-08-01T01:02:00.000Z"),
  }));
  return { db, backend, chargeUsage };
}

describe("Fleet worker rendered output", () => {
  it("captures one exact active persisted session through the backend", async () => {
    const { db, backend, chargeUsage } = fixture();
    const result = await captureFleetWorkerOutput(
      {
        runId: "run-1",
        workerId: "worker-1",
        expectedAttempt: 2,
        expectedSessionId: "session-1",
        lines: 2,
      },
      {
        db,
        backend,
        chargeUsage,
        now: () => new Date("2026-08-01T01:02:03.000Z"),
      }
    );

    expect(result).toEqual({
      ok: true,
      output: {
        runId: "run-1",
        workerId: "worker-1",
        attempt: 2,
        sessionId: "session-1",
        lines: 2,
        output: "rendered\nlatest",
        truncated: true,
        capturedAt: "2026-08-01T01:02:03.000Z",
      },
    });
    expect(backend.exists).toHaveBeenCalledWith("hermes-exact-worker");
    expect(backend.capture).toHaveBeenCalledWith("hermes-exact-worker", {
      lines: 2,
    });
    expect(chargeUsage).toHaveBeenCalledWith(db, {
      runId: "run-1",
      kind: "output_bytes_per_minute",
      units: Buffer.byteLength("rendered\nlatest", "utf8"),
      now: new Date("2026-08-01T01:02:03.000Z"),
    });
    db.close();
  });

  it("rejects stale attempt/session bindings before observing the terminal", async () => {
    const { db, backend, chargeUsage } = fixture();
    const result = await captureFleetWorkerOutput(
      {
        runId: "run-1",
        workerId: "worker-1",
        expectedAttempt: 1,
        expectedSessionId: "session-old",
      },
      { db, backend, chargeUsage }
    );

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(backend.exists).not.toHaveBeenCalled();
    expect(backend.capture).not.toHaveBeenCalled();
    expect(chargeUsage).not.toHaveBeenCalled();
    db.close();
  });

  it("fails closed if the worker changes during capture", async () => {
    const { db, backend, chargeUsage } = fixture();
    backend.capture.mockImplementation(async () => {
      db.prepare(
        "UPDATE fleet_workers SET status = 'failed' WHERE id = 'worker-1'"
      ).run();
      return "stale output";
    });
    const result = await captureFleetWorkerOutput(
      {
        runId: "run-1",
        workerId: "worker-1",
        expectedAttempt: 2,
        expectedSessionId: "session-1",
      },
      { db, backend, chargeUsage }
    );

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(chargeUsage).not.toHaveBeenCalled();
    db.close();
  });

  it("bounds long rendered rows even when a backend over-returns", async () => {
    const { db, backend, chargeUsage } = fixture();
    backend.capture.mockResolvedValue(
      "x".repeat(FLEET_WORKER_OUTPUT_MAX_CHARS + 9)
    );
    const result = await captureFleetWorkerOutput(
      {
        runId: "run-1",
        workerId: "worker-1",
        expectedAttempt: 2,
        expectedSessionId: "session-1",
      },
      { db, backend, chargeUsage }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.output).toHaveLength(FLEET_WORKER_OUTPUT_MAX_CHARS);
      expect(result.output.truncated).toBe(true);
    }
    db.close();
  });

  it("charges exact UTF-8 bytes and fails closed when the run quota is full", async () => {
    const { db, backend, chargeUsage } = fixture();
    backend.capture.mockResolvedValue("one π");
    chargeUsage.mockReturnValue({
      admitted: false as const,
      blocked: [],
      retryAt: null,
    });

    const result = await captureFleetWorkerOutput(
      {
        runId: "run-1",
        workerId: "worker-1",
        expectedAttempt: 2,
        expectedSessionId: "session-1",
      },
      {
        db,
        backend,
        chargeUsage,
        now: () => new Date("2026-08-01T01:02:03.000Z"),
      }
    );

    expect(result).toEqual({
      ok: false,
      status: 429,
      error: "Fleet rendered output quota exceeded",
      retryAt: null,
    });
    expect(chargeUsage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        kind: "output_bytes_per_minute",
        units: Buffer.byteLength("one π", "utf8"),
      })
    );
    expect(JSON.stringify(result)).not.toContain("one π");
    db.close();
  });
});
