import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import {
  decideFleetAuxiliaryLaunchRetry,
  FLEET_AUXILIARY_LAUNCH_MAX_FAILURES,
} from "@/lib/fleet/auxiliary-retry";

function memoryDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  createSchema(db);
  runMigrations(db);
  return db;
}

describe("Fleet auxiliary launch retry policy", () => {
  it("uses deterministic bounded backoff and records provider cooldown", () => {
    const db = memoryDb();
    const now = new Date("2026-08-01T12:00:00.000Z");
    const first = decideFleetAuxiliaryLaunchRetry(db, {
      provider: "CoDeX",
      previousFailureCount: 0,
      error: new Error("429 too many requests"),
      now,
      safeToRetry: true,
    });

    expect(first).toEqual({
      failureCount: 1,
      retry: true,
      retryNotBefore: "2026-08-01T12:00:05.000Z",
      providerRateLimited: true,
    });
    expect(
      db
        .prepare(
          `SELECT provider, blocked_until, failure_count
           FROM fleet_provider_cooldowns WHERE provider = ?`
        )
        .get("codex")
    ).toEqual({
      provider: "codex",
      blocked_until: first.retryNotBefore,
      failure_count: 1,
    });

    const terminal = decideFleetAuxiliaryLaunchRetry(db, {
      provider: "codex",
      previousFailureCount: FLEET_AUXILIARY_LAUNCH_MAX_FAILURES - 1,
      error: new Error("provider rate limit"),
      now,
      safeToRetry: true,
    });
    expect(terminal).toMatchObject({
      failureCount: FLEET_AUXILIARY_LAUNCH_MAX_FAILURES,
      retry: false,
      retryNotBefore: null,
    });
    expect(
      db
        .prepare(
          `SELECT failure_count FROM fleet_provider_cooldowns WHERE provider = ?`
        )
        .get("codex")
    ).toEqual({ failure_count: 2 });
    db.close();
  });

  it("does not retry permanent errors or launches with ambiguous ownership", () => {
    const db = memoryDb();
    const common = {
      provider: "codex",
      previousFailureCount: 0,
      now: new Date("2026-08-01T12:00:00.000Z"),
    };
    expect(
      decideFleetAuxiliaryLaunchRetry(db, {
        ...common,
        error: new Error("unsupported provider configuration"),
        safeToRetry: true,
      })
    ).toMatchObject({ retry: false, failureCount: 1 });
    expect(
      decideFleetAuxiliaryLaunchRetry(db, {
        ...common,
        error: new Error("service unavailable"),
        safeToRetry: false,
      })
    ).toMatchObject({ retry: false, failureCount: 1 });
    db.close();
  });
});
