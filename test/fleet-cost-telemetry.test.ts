import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import type { Session } from "@/lib/db";
import { registerFleetCostAccount } from "@/lib/fleet/cost-runtime";
import { reconcileFleetCostTelemetry } from "@/lib/fleet/scheduler";

describe("Fleet cost telemetry cadence", () => {
  it("actively samples at most eight accounts and skips the next 30-second tick", async () => {
    const db = new Database(":memory:");
    createSchema(db);
    db.prepare(
      `INSERT INTO fleet_runs (id, name, goal) VALUES ('run-1', 'Fleet', 'Goal')`
    ).run();
    for (let index = 0; index < 10; index++) {
      const id = `session-${index}`;
      db.prepare(
        `INSERT INTO sessions
         (id, name, tmux_name, status, working_directory, model, group_path, agent_type)
         VALUES (?, ?, ?, 'running', 'C:\\repo', 'gpt-5.4', 'sessions', 'codex')`
      ).run(id, id, `codex-${id}`);
      const session = db
        .prepare(`SELECT * FROM sessions WHERE id = ?`)
        .get(id) as Session;
      registerFleetCostAccount(db, {
        runId: "run-1",
        ownerType: "worker",
        ownerId: `owner-${index}`,
        session,
        provider: "codex",
        model: "gpt-5.4",
        confidence: "medium",
      });
    }
    const now = new Date("2026-08-01T12:00:00.000Z");
    const sampleCosts = vi.fn(async (sessions: Session[]) => sessions.length);
    expect(
      await reconcileFleetCostTelemetry({ db, now: () => now, sampleCosts })
    ).toBe(8);
    expect(sampleCosts).toHaveBeenCalledTimes(1);
    expect(sampleCosts.mock.calls[0]?.[0]).toHaveLength(8);
    expect(
      await reconcileFleetCostTelemetry({ db, now: () => now, sampleCosts })
    ).toBe(0);
    expect(sampleCosts).toHaveBeenCalledTimes(1);
  });
});
