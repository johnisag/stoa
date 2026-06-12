/**
 * Command Stoa execute path: executeCreateSession creates the right plain-session
 * row (directory from the project, NOT the caller; auto_approve OFF), and
 * auditCommand appends to the session_events ledger under the synthetic key and
 * honors the STOA_AUDIT opt-out. Uses a real in-memory SQLite (real schema +
 * migrations + queries) with getDb() mocked to point at it — the audit-ledger
 * test's pattern.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => state.db };
});

import { queries } from "@/lib/db";
import type { Session, SessionEvent } from "@/lib/db/types";
import { executeCreateSession } from "@/lib/command/create-session";
import { auditCommand, COMMAND_AUDIT_KEY } from "@/lib/command/audit";

function db() {
  return state.db as InstanceType<typeof Database>;
}

const PROJECT = {
  id: "proj_test",
  working_directory: "~/work/the-grid",
  default_model: "sonnet" as string | null,
};

beforeAll(() => {
  const memory = new Database(":memory:");
  createSchema(memory);
  runMigrations(memory);
  state.db = memory;
});

beforeEach(() => {
  db().exec(
    "DELETE FROM sessions; DELETE FROM session_events; DELETE FROM projects;"
  );
  // Seed the project so the sessions.project_id foreign key is satisfied.
  queries
    .createProject(db())
    .run(
      PROJECT.id,
      "the-grid",
      PROJECT.working_directory,
      "claude",
      PROJECT.default_model,
      null,
      1
    );
});

describe("executeCreateSession", () => {
  it("creates a plain session in the PROJECT's directory, never the caller's", () => {
    const created = executeCreateSession(
      {
        projectId: PROJECT.id,
        agentType: "claude",
        model: "opus",
        name: "Fix bug",
      },
      PROJECT
    );
    const row = queries.getSession(db()).get(created.id) as Session;
    expect(row.working_directory).toBe("~/work/the-grid"); // from the project
    expect(row.agent_type).toBe("claude");
    expect(row.model).toBe("opus");
    expect(row.name).toBe("Fix bug");
    expect(row.project_id).toBe("proj_test");
    expect(row.tmux_name).toBe(`claude-${created.id}`);
  });

  it("never creates an auto-approving (permission-bypassing) session", () => {
    const created = executeCreateSession(
      { projectId: PROJECT.id, agentType: "codex" },
      PROJECT
    );
    const row = queries.getSession(db()).get(created.id) as Session;
    expect(row.auto_approve).toBe(0);
  });

  it("auto-generates a unique 'Session N' name when none is given", () => {
    const a = executeCreateSession(
      { projectId: PROJECT.id, agentType: "claude" },
      PROJECT
    );
    const b = executeCreateSession(
      { projectId: PROJECT.id, agentType: "claude" },
      PROJECT
    );
    const nameA = (queries.getSession(db()).get(a.id) as Session).name;
    const nameB = (queries.getSession(db()).get(b.id) as Session).name;
    expect(nameA).toMatch(/^Session \d+$/);
    expect(nameB).toMatch(/^Session \d+$/);
    expect(nameA).not.toBe(nameB);
  });
});

describe("auditCommand", () => {
  function commandEvents(): SessionEvent[] {
    return queries
      .getSessionEvents(db())
      .all(COMMAND_AUDIT_KEY) as SessionEvent[];
  }

  afterEach(() => {
    delete process.env.STOA_AUDIT;
  });

  it("appends a command event under the synthetic key", () => {
    auditCommand("command_executed", {
      action: "create_session",
      sessionId: "s1",
    });
    const events = commandEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("command_executed");
    expect(events[0].session_key).toBe(COMMAND_AUDIT_KEY);
    expect(JSON.parse(events[0].payload as string).sessionId).toBe("s1");
  });

  it("is a no-op when the ledger is disabled (STOA_AUDIT=0)", () => {
    process.env.STOA_AUDIT = "0";
    auditCommand("command_proposed", { foo: "bar" });
    expect(commandEvents()).toHaveLength(0);
  });

  it("bounds an oversized payload instead of writing it verbatim", () => {
    // A crafted/large rejected body must not bloat the ledger row.
    auditCommand("command_rejected", { body: "x".repeat(20_000) });
    const [event] = commandEvents();
    const payload = JSON.parse(event.payload as string);
    expect(payload.truncated).toBe(true);
    expect(payload.bytes).toBeGreaterThan(8 * 1024);
    expect((event.payload as string).length).toBeLessThan(2048);
  });
});
