import { resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchema } from "@/lib/db/schema";
import { sessionKey } from "@/lib/providers/registry";
import {
  managedSupervisorBrokerProfile,
  managedSupervisorProfileHash,
  managedSupervisorProfileJson,
  MANAGED_SUPERVISOR_BROKER_VERSION,
  MANAGED_SUPERVISOR_GROUP_PATH,
  MANAGED_SUPERVISOR_SESSION_ROLE,
} from "@/lib/fleet/supervisor-broker";
import {
  managedSupervisorSessionTask,
  validateManagedSupervisorSessionIdentity,
} from "@/lib/fleet/supervisor-session-identity";
import { reconcileUntrackedManagedFleetSupervisors } from "@/lib/fleet/supervisor-recovery";

const RUN_ID = "fallback-run";
const REQUEST_ID = "fallback-request";
const SESSION_ID = "fallback-session";
const MODEL = "sonnet";
const NOW = new Date("2026-08-02T12:00:00.000Z");
const PROVIDER_FIXTURE = resolve("test/fixtures/fleet-supervisor-provider.cjs");

describe("managed supervisor settings-corruption recovery", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    createSchema(db);
  });

  afterEach(() => db.close());

  function seed(settingsJson: string): void {
    const backendKey = sessionKey({
      kind: "agent",
      provider: "claude",
      id: SESSION_ID,
    });
    const workingDirectory = resolve("test");
    const profileJson = managedSupervisorProfileJson(
      managedSupervisorBrokerProfile(
        {
          schemaVersion: MANAGED_SUPERVISOR_BROKER_VERSION,
          binary: process.execPath,
          argsPrefix: [PROVIDER_FIXTURE],
          model: MODEL,
        },
        {
          backendKey,
          workingDirectory,
          groupPath: MANAGED_SUPERVISOR_GROUP_PATH,
          projectId: null,
        }
      )
    );
    const profileHash = managedSupervisorProfileHash(profileJson);

    db.prepare(
      `INSERT INTO fleet_runs
       (id, name, goal, status, desired_state, approval_state, provider, model,
        settings_json, reserved_budget_usd, reserved_budget_tokens)
       VALUES (?, 'Fallback', 'Recover corrupt supervisor state', 'running',
        'running', 'approved', 'codex', 'gpt-5.4', ?, 2.5, 100)`
    ).run(RUN_ID, settingsJson);
    db.prepare(
      `INSERT INTO sessions
       (id, name, tmux_name, status, working_directory, model, group_path,
        agent_type, auto_approve, approval_mode, worker_task, worker_status,
        session_role, launch_profile_json, launch_profile_hash)
       VALUES (?, 'Fleet managed supervisor', ?, 'running', ?, ?, ?, 'claude',
        0, 'prompt', ?, 'running', ?, ?, ?)`
    ).run(
      SESSION_ID,
      backendKey,
      workingDirectory,
      MODEL,
      MANAGED_SUPERVISOR_GROUP_PATH,
      managedSupervisorSessionTask(RUN_ID, REQUEST_ID),
      MANAGED_SUPERVISOR_SESSION_ROLE,
      profileJson,
      profileHash
    );
    db.prepare(
      `INSERT INTO fleet_cost_accounts
       (id, fleet_run_id, session_id, session_key, owner_type, owner_id,
        provider, model, reservation_usd, reservation_tokens)
       VALUES ('fallback-account', ?, ?, ?, 'supervisor', ?, 'claude', ?, 2.5, 100)`
    ).run(RUN_ID, SESSION_ID, backendKey, REQUEST_ID, MODEL);
    db.prepare(
      `INSERT INTO fleet_runtime_leases
       (id, fleet_run_id, owner_type, owner_id, resource_type, resource_key,
        units, status)
       VALUES ('fallback-lease', ?, 'supervisor', ?, 'provider', 'claude',
        1, 'reserved')`
    ).run(RUN_ID, REQUEST_ID);
  }

  it.each(["not-json", "{}"])(
    "stops and conservatively settles an exact identity hidden by settings %s",
    async (settingsJson) => {
      seed(settingsJson);
      const sessionExists = vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const stopSession = vi.fn(async () => true);

      await expect(
        reconcileUntrackedManagedFleetSupervisors({
          db,
          now: () => new Date(NOW),
          sessionExists,
          stopSession,
        })
      ).resolves.toEqual({
        inspected: 1,
        recovered: 1,
        recoveryRequired: 0,
      });

      expect(stopSession).toHaveBeenCalledWith(SESSION_ID, "failed");
      expect(
        db
          .prepare(
            `SELECT terminal_at, reservation_released_at, charged_cost_usd,
                    charged_tokens
             FROM fleet_cost_accounts WHERE id = 'fallback-account'`
          )
          .get()
      ).toEqual({
        terminal_at: NOW.toISOString(),
        reservation_released_at: NOW.toISOString(),
        charged_cost_usd: 2.5,
        charged_tokens: 100,
      });
      expect(
        db
          .prepare(
            `SELECT reserved_budget_usd, reserved_budget_tokens,
                    spent_budget_usd, spent_budget_tokens, recovery_required
             FROM fleet_runs WHERE id = ?`
          )
          .get(RUN_ID)
      ).toEqual({
        reserved_budget_usd: 0,
        reserved_budget_tokens: 0,
        spent_budget_usd: 2.5,
        spent_budget_tokens: 100,
        recovery_required: 0,
      });
      expect(
        db
          .prepare(`SELECT worker_status FROM sessions WHERE id = ?`)
          .get(SESSION_ID)
      ).toEqual({ worker_status: "failed" });
      expect(
        db
          .prepare(
            `SELECT status, released_at FROM fleet_runtime_leases
             WHERE id = 'fallback-lease'`
          )
          .get()
      ).toEqual({ status: "released", released_at: NOW.toISOString() });
    }
  );

  it("marks recovery required without probing or stopping an ambiguously owned identity", async () => {
    seed("not-json");
    db.prepare(
      `INSERT INTO fleet_runs (id, name, goal)
       VALUES ('foreign-run', 'Foreign', 'Foreign ownership')`
    ).run();
    db.prepare(
      `INSERT INTO fleet_cost_accounts
       (id, fleet_run_id, session_id, session_key, owner_type, owner_id,
        provider, model)
       VALUES ('foreign-account', 'foreign-run', ?, 'foreign-key', 'worker',
        'foreign-worker', 'claude', ?)`
    ).run(SESSION_ID, MODEL);
    const sessionExists = vi.fn(async () => true);
    const stopSession = vi.fn(async () => true);

    await expect(
      reconcileUntrackedManagedFleetSupervisors({
        db,
        now: () => new Date(NOW),
        sessionExists,
        stopSession,
      })
    ).resolves.toEqual({
      inspected: 1,
      recovered: 0,
      recoveryRequired: 1,
    });

    expect(sessionExists).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
    expect(
      db
        .prepare(`SELECT recovery_required FROM fleet_runs WHERE id = ?`)
        .get(RUN_ID)
    ).toEqual({ recovery_required: 1 });
    expect(
      db
        .prepare(
          `SELECT terminal_at, reservation_released_at
           FROM fleet_cost_accounts WHERE id = 'fallback-account'`
        )
        .get()
    ).toEqual({ terminal_at: null, reservation_released_at: null });
  });

  it("rotates a bounded corrupt-state batch to a later exact identity", async () => {
    seed("not-json");
    db.prepare(
      `UPDATE fleet_cost_accounts SET fallback_recovery_cursor = 1
       WHERE id = 'fallback-account'`
    ).run();
    for (let index = 0; index < 2; index += 1) {
      const runId = `ambiguous-run-${index}`;
      db.prepare(
        `INSERT INTO fleet_runs (id, name, goal, settings_json)
         VALUES (?, 'Ambiguous', 'Require operator recovery', 'not-json')`
      ).run(runId);
      db.prepare(
        `INSERT INTO fleet_cost_accounts
         (id, fleet_run_id, session_id, session_key, owner_type, owner_id,
          provider, model)
         VALUES (?, ?, NULL, ?, 'supervisor', ?, 'claude', ?)`
      ).run(
        `ambiguous-account-${index}`,
        runId,
        `pending:ambiguous-${index}`,
        `ambiguous-request-${index}`,
        MODEL
      );
    }
    const sessionExists = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const stopSession = vi.fn(async () => true);
    const deps = {
      db,
      now: () => new Date(NOW),
      sessionExists,
      stopSession,
    };

    await expect(
      reconcileUntrackedManagedFleetSupervisors(deps, 2)
    ).resolves.toEqual({ inspected: 2, recovered: 0, recoveryRequired: 2 });
    expect(sessionExists).not.toHaveBeenCalled();

    await expect(
      reconcileUntrackedManagedFleetSupervisors(deps, 2)
    ).resolves.toEqual({ inspected: 2, recovered: 1, recoveryRequired: 0 });
    expect(stopSession).toHaveBeenCalledWith(SESSION_ID, "failed");
    expect(
      db
        .prepare(
          `SELECT terminal_at, reservation_released_at
           FROM fleet_cost_accounts WHERE id = 'fallback-account'`
        )
        .get()
    ).toEqual({
      terminal_at: NOW.toISOString(),
      reservation_released_at: NOW.toISOString(),
    });
  });

  it("pins the canonical backend and all persisted launch fields", () => {
    seed("{}");
    const session = db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(SESSION_ID) as Parameters<
      typeof validateManagedSupervisorSessionIdentity
    >[0]["session"];
    const account = db
      .prepare(
        `SELECT * FROM fleet_cost_accounts WHERE id = 'fallback-account'`
      )
      .get() as NonNullable<
      Parameters<typeof validateManagedSupervisorSessionIdentity>[0]["account"]
    >;
    expect(
      validateManagedSupervisorSessionIdentity({
        session,
        account,
        runId: RUN_ID,
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        expectedModel: MODEL,
        expectedProfileHash: session?.launch_profile_hash,
      })
    ).toMatchObject({ ok: true });

    db.exec(`DROP TRIGGER trg_sessions_launch_profile_immutable`);
    db.prepare(
      `UPDATE sessions SET tmux_name = 'foreign-key' WHERE id = ?`
    ).run(SESSION_ID);
    const tampered = db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(SESSION_ID) as typeof session;
    expect(
      validateManagedSupervisorSessionIdentity({
        session: tampered,
        account,
        runId: RUN_ID,
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
      })
    ).toEqual({
      ok: false,
      error: "managed supervisor immutable session profile does not match",
    });
  });
});
