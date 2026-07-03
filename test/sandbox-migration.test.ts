/**
 * #27 approval_mode column — migration 53 (schema/backfill parity) + the launch
 * resolver's fail-closed derivation.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { resolveSessionLaunchOptions } from "@/lib/session-launch";
import type { Session } from "@/lib/db";

describe("migration 53 — approval_mode", () => {
  it("fresh schema carries approval_mode as TEXT (mirrors the migration)", () => {
    const d = new Database(":memory:");
    createSchema(d);
    runMigrations(d);
    const col = (
      d.prepare("PRAGMA table_info(sessions)").all() as {
        name: string;
        type: string;
      }[]
    ).find((c) => c.name === "approval_mode");
    expect(col).toBeTruthy();
    expect(col!.type).toBe("TEXT");
  });

  it("backfills from auto_approve on upgrade (1→full-bypass, 0→prompt)", () => {
    // A pre-53 sessions table (no approval_mode column).
    const d = new Database(":memory:");
    d.exec(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, auto_approve INTEGER NOT NULL DEFAULT 0)"
    );
    d.prepare("INSERT INTO sessions (id, auto_approve) VALUES (?, ?)").run(
      "a",
      1
    );
    d.prepare("INSERT INTO sessions (id, auto_approve) VALUES (?, ?)").run(
      "b",
      0
    );
    // The exact migration-53 statements (locks the backfill semantics).
    d.exec("ALTER TABLE sessions ADD COLUMN approval_mode TEXT");
    d.exec(
      "UPDATE sessions SET approval_mode = CASE WHEN auto_approve = 1 THEN 'full-bypass' ELSE 'prompt' END WHERE approval_mode IS NULL"
    );
    expect(
      d.prepare("SELECT id, approval_mode FROM sessions ORDER BY id").all()
    ).toEqual([
      { id: "a", approval_mode: "full-bypass" },
      { id: "b", approval_mode: "prompt" },
    ]);
  });
});

describe("resolveSessionLaunchOptions — approval mode", () => {
  const base = (over: Partial<Session>): Session =>
    ({
      id: "s",
      name: "s",
      agent_type: "claude",
      claude_session_id: null,
      parent_session_id: null,
      model: "sonnet",
      mcp_launch_args: null,
      auto_approve: false,
      ...over,
    }) as unknown as Session;

  it("passes an explicit approval_mode through", () => {
    const r = resolveSessionLaunchOptions(
      base({ approval_mode: "sandboxed-auto" })
    );
    expect(r?.options.approvalMode).toBe("sandboxed-auto");
    // sandboxActive is NOT set here (server-side spawn computes the wrap), so a
    // sandboxed-auto reaching this client-shared resolver fails closed.
    expect(r?.options.sandboxActive).toBeUndefined();
  });

  it("derives from auto_approve when approval_mode is null (unchanged behavior)", () => {
    expect(
      resolveSessionLaunchOptions(
        base({ approval_mode: null, auto_approve: true })
      )?.options.approvalMode
    ).toBe("full-bypass");
    expect(
      resolveSessionLaunchOptions(
        base({ approval_mode: null, auto_approve: false })
      )?.options.approvalMode
    ).toBe("prompt");
  });

  it("fails closed to 'prompt' on a garbage approval_mode", () => {
    expect(
      resolveSessionLaunchOptions(base({ approval_mode: "root" as string }))
        ?.options.approvalMode
    ).toBe("prompt");
  });
});
