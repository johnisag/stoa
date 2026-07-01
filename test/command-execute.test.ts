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
import { executeDispatchIssue } from "@/lib/command/dispatch-issue";
import { executeListSessions } from "@/lib/command/list-sessions";
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

const REPO = {
  id: "repo_test",
  repo_slug: "owner/test-repo",
  repo_path: "~/repos/test-repo",
};

beforeEach(() => {
  db().exec(
    "DELETE FROM sessions; DELETE FROM session_events; DELETE FROM projects; DELETE FROM dispatch_repos; DELETE FROM issue_dispatches;"
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
  // Seed a dispatch repo for dispatch_issue tests.
  queries.createDispatchRepo(db()).run(
    REPO.id,
    REPO.repo_path,
    REPO.repo_slug,
    "claude", // agent_type
    5, // daily_quota
    2, // max_concurrency
    null, // label_filter
    "main", // base_branch
    "auto", // mode
    1, // enabled
    0, // review_gate
    0, // ci_autofix
    0, // merge_train
    0, // verify_gate
    null, // verify_command
    null // project_id
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

  it("seeds a project recipe + pinned knowledge, and NEVER a foreign project's recipe (#13)", () => {
    queries
      .createPlaybook(db())
      .run("pb_ok", "OK", "PROJECT RECIPE BODY", PROJECT.id, 0);
    queries
      .createPlaybook(db())
      .run("pb_pin", "Pin", "PINNED FACT", PROJECT.id, 1);
    // A recipe owned by ANOTHER project — a prompt-injected id must not pull it.
    queries
      .createProject(db())
      .run("proj_other", "Other", "~/other", "claude", "sonnet", null, 9);
    queries
      .createPlaybook(db())
      .run("pb_foreign", "Foreign", "FOREIGN SECRET BODY", "proj_other", 0);

    const ok = executeCreateSession(
      {
        projectId: PROJECT.id,
        agentType: "claude",
        initialPrompt: "do it",
        playbookId: "pb_ok",
      },
      PROJECT
    );
    expect(ok.initialPrompt).toContain("PROJECT RECIPE BODY");
    expect(ok.initialPrompt).toContain("PINNED FACT"); // auto-recalled
    expect(ok.initialPrompt).toContain("do it");

    const foreign = executeCreateSession(
      {
        projectId: PROJECT.id,
        agentType: "claude",
        initialPrompt: "task",
        playbookId: "pb_foreign",
      },
      PROJECT
    );
    expect(foreign.initialPrompt).not.toContain("FOREIGN SECRET BODY"); // scoped out
    expect(foreign.initialPrompt).toContain("PINNED FACT"); // still gets own pins
    expect(foreign.initialPrompt).toContain("task");
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

// ── seed-prompt (initialPrompt) flow ─────────────────────────────────────────

describe("executeCreateSession — initialPrompt seed-prompt flow", () => {
  it("returns initialPrompt in the result when provided", () => {
    const created = executeCreateSession(
      {
        projectId: PROJECT.id,
        agentType: "claude",
        initialPrompt: "Hello, start the refactor",
      },
      PROJECT
    );
    expect(created.initialPrompt).toBe("Hello, start the refactor");
  });

  it("omits initialPrompt from the result when not provided", () => {
    const created = executeCreateSession(
      { projectId: PROJECT.id, agentType: "claude" },
      PROJECT
    );
    expect(created.initialPrompt).toBeUndefined();
  });

  it("does not persist initialPrompt in the DB row (ephemeral delivery only)", () => {
    const created = executeCreateSession(
      {
        projectId: PROJECT.id,
        agentType: "claude",
        initialPrompt: "seed message",
      },
      PROJECT
    );
    const row = queries.getSession(db()).get(created.id) as unknown as Record<
      string,
      unknown
    >;
    // The sessions table has no initialPrompt/seed_prompt column — it should
    // not appear on the row (the row type has no such field).
    expect(row.initialPrompt).toBeUndefined();
    expect(row.seed_prompt).toBeUndefined();
  });
});

// ── dispatch_issue executor ───────────────────────────────────────────────────

describe("executeDispatchIssue", () => {
  it("inserts a local task row with the correct repo and title", () => {
    const result = executeDispatchIssue(
      { repoId: REPO.id, title: "Fix the login bug", body: "Details here" },
      { id: REPO.id, repo_slug: REPO.repo_slug }
    );
    expect(result.repoSlug).toBe(REPO.repo_slug);
    expect(result.title).toBe("Fix the login bug");
    expect(result.dispatchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    // The row should be in the DB as a local pending task.
    const row = queries.getDispatch(db()).get(result.dispatchId) as Record<
      string,
      unknown
    >;
    expect(row).toBeTruthy();
    expect(row.issue_title).toBe("Fix the login bug");
    expect(row.task_body).toBe("Details here");
    expect(row.source).toBe("local");
    expect(row.status).toBe("pending");
    expect(row.repo_id).toBe(REPO.id);
  });

  it("handles a missing body gracefully (sets task_body to null)", () => {
    const result = executeDispatchIssue(
      { repoId: REPO.id, title: "No body task" },
      { id: REPO.id, repo_slug: REPO.repo_slug }
    );
    const row = queries.getDispatch(db()).get(result.dispatchId) as Record<
      string,
      unknown
    >;
    expect(row.task_body).toBeNull();
  });
});

// ── list_sessions executor ────────────────────────────────────────────────────

describe("executeListSessions", () => {
  beforeEach(() => {
    // Create a couple of sessions with different statuses.
    executeCreateSession(
      { projectId: PROJECT.id, agentType: "claude", name: "S-running" },
      PROJECT
    );
    executeCreateSession(
      { projectId: PROJECT.id, agentType: "codex", name: "S-idle" },
      PROJECT
    );
    // Manually set one to running status.
    const all = queries.getAllSessions(db()).all() as Session[];
    const running = all.find((s) => s.name === "S-running");
    if (running) {
      queries.updateSessionStatus(db()).run("running", running.id);
    }
  });

  it("returns all sessions when no status filter is given", () => {
    const result = executeListSessions({});
    expect(result.total).toBeGreaterThanOrEqual(2);
    expect(result.sessions.length).toBe(result.total);
    expect(result.sessions[0]).toHaveProperty("id");
    expect(result.sessions[0]).toHaveProperty("name");
    expect(result.sessions[0]).toHaveProperty("status");
    expect(result.sessions[0]).toHaveProperty("agentType");
  });

  it("filters by status when provided", () => {
    const running = executeListSessions({ status: "running" });
    expect(running.sessions.every((s) => s.status === "running")).toBe(true);

    const idle = executeListSessions({ status: "idle" });
    expect(idle.sessions.every((s) => s.status === "idle")).toBe(true);

    // All running + idle should sum to total (since we only have those two statuses).
    const all = executeListSessions({});
    expect(running.total + idle.total).toBe(all.total);
  });

  it("returns an empty list when no sessions match the filter", () => {
    const result = executeListSessions({ status: "waiting" });
    expect(result.total).toBe(0);
    expect(result.sessions).toHaveLength(0);
  });
});
