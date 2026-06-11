/**
 * Local (GitHub-free) task intake (#7): the worker prompt must drop the gh
 * issue/Closes lines for a local task, and the dedupe index must stay
 * GitHub-only so local tasks (issue_number 0) never collide while real issues
 * still de-duplicate. Pure prompt assertions + a real in-memory SQLite for the
 * partial-index behavior.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db";
import { buildIssuePrompt } from "@/lib/dispatch/dispatcher";
import {
  buildLensReviewPrompt,
  buildFixPrompt,
  REVIEW_LENSES,
} from "@/lib/dispatch/reviewer";
import { buildCiFixPrompt } from "@/lib/dispatch/ci-fix";
import { buildRebaseFixPrompt } from "@/lib/dispatch/merge-train";
import { isLocalTask, taskLabel, taskRef } from "@/lib/dispatch/task-label";
import type { DispatchRepo, IssueDispatch } from "@/lib/dispatch/types";

describe("task-label helpers (the single local-vs-github discriminator)", () => {
  const gh = { source: "github", issue_number: 42, issue_title: "Fix login" };
  const local = {
    source: "local",
    issue_number: 0,
    issue_title: "Add dark mode",
  };

  it("isLocalTask keys on source", () => {
    expect(isLocalTask(gh)).toBe(false);
    expect(isLocalTask(local)).toBe(true);
  });
  it("taskLabel: #N for github, bare title for local", () => {
    expect(taskLabel(gh)).toBe("#42 Fix login");
    expect(taskLabel(local)).toBe("Add dark mode");
  });
  it("taskRef: issue #N for github, task for local (never #0)", () => {
    expect(taskRef(gh)).toBe('issue #42: "Fix login"');
    expect(taskRef(local)).toBe('task: "Add dark mode"');
    expect(taskRef(local)).not.toContain("#0");
  });
});

// buildIssuePrompt only reads repo_slug + base_branch.
const baseRepo = {
  repo_slug: "o/r",
  base_branch: "main",
} as unknown as DispatchRepo;

describe("buildIssuePrompt — GitHub issue vs local task", () => {
  it("GitHub issue: tells the worker to read the issue and Closes #N", () => {
    const p = buildIssuePrompt(baseRepo, 42, "Fix login", "/wt", "br");
    expect(p).toContain("gh issue view 42 --repo o/r");
    expect(p).toContain("Closes #42");
    expect(p).toContain("GitHub issue #42");
  });

  it("local task: NO gh issue view, NO Closes, carries the freeform body", () => {
    const p = buildIssuePrompt(
      baseRepo,
      0,
      "Add dark mode",
      "/wt",
      "br",
      "",
      "make the toggle persist across reloads"
    );
    expect(p).not.toContain("gh issue view");
    expect(p).not.toContain("Closes #");
    expect(p).toContain("complete this task");
    expect(p).toContain('"Add dark mode"');
    expect(p).toContain("make the toggle persist across reloads");
    // still opens a PR (that's how the change lands)
    expect(p).toContain("gh pr create");
  });

  it("local task with no body: still valid (no empty body section)", () => {
    const p = buildIssuePrompt(baseRepo, 0, "Quick chore", "/wt", "br");
    expect(p).not.toContain("gh issue view");
    expect(p).toContain('"Quick chore"');
  });

  it("appends the fleet-memory lessons block in both modes", () => {
    const lessons = "\n\nKNOWN PITFALLS IN THIS REPO";
    expect(buildIssuePrompt(baseRepo, 1, "t", "/wt", "br", lessons)).toContain(
      "KNOWN PITFALLS IN THIS REPO"
    );
    expect(
      buildIssuePrompt(baseRepo, 0, "t", "/wt", "br", lessons, "body")
    ).toContain("KNOWN PITFALLS IN THIS REPO");
  });
});

// The downstream pipeline (critic + fixers) must also handle a local task without
// emitting "#0" or the failing `gh issue view 0` — the gap the review caught.
describe("downstream prompts for a local task", () => {
  const repo = {
    repo_slug: "octo/app",
    base_branch: "main",
  } as unknown as DispatchRepo;
  const localD = {
    pr_number: 12,
    issue_number: 0,
    issue_title: "Add dark mode",
    task_body: "make the toggle persist across reloads",
    source: "local",
    fix_rounds: 0,
    branch_name: "feat/dark",
  } as unknown as IssueDispatch;
  const ghD = {
    pr_number: 12,
    issue_number: 7,
    issue_title: "Fix X",
    source: "github",
    fix_rounds: 0,
    branch_name: "feat/x",
  } as unknown as IssueDispatch;

  it("critic brief omits `gh issue view`, inlines the task body, says 'task:'", () => {
    const p = buildLensReviewPrompt(repo, localD, REVIEW_LENSES[0]);
    expect(p).not.toContain("gh issue view");
    expect(p).not.toContain("#0");
    expect(p).toContain('task: "Add dark mode"');
    expect(p).toContain("make the toggle persist across reloads");
    expect(p).toContain("gh pr diff 12"); // still reviews the PR
  });

  it("critic brief for a GitHub task is unchanged (reads the issue)", () => {
    const p = buildLensReviewPrompt(repo, ghD, REVIEW_LENSES[0]);
    expect(p).toContain("gh issue view 7 --repo octo/app");
    expect(p).toContain('issue #7: "Fix X"');
  });

  it("fixer / CI-fixer / rebase-fixer briefs reference the task, never issue #0", () => {
    for (const p of [
      buildFixPrompt(repo, localD),
      buildCiFixPrompt(repo, localD),
      buildRebaseFixPrompt(repo, localD),
    ]) {
      expect(p).not.toContain("issue #0");
      expect(p).toContain('task: "Add dark mode"');
    }
  });
});

describe("local task intake — partial dedupe index", () => {
  let db: InstanceType<typeof Database>;
  const repoId = "repo-1";

  beforeAll(() => {
    db = new Database(":memory:");
    createSchema(db);
    runMigrations(db);
  });

  beforeEach(() => {
    db.exec("DELETE FROM issue_dispatches; DELETE FROM dispatch_repos;");
    queries
      .createDispatchRepo(db)
      .run(
        repoId,
        "/tmp/repo",
        "o/r",
        "claude",
        5,
        5,
        null,
        "main",
        "auto",
        1,
        0,
        0,
        0,
        0,
        null,
        "uncategorized"
      );
  });

  it("GitHub candidates still de-duplicate on (repo, issue_number)", () => {
    queries
      .upsertDispatchCandidate(db)
      .run(randomUUID(), repoId, 5, "Issue 5", "u", "t");
    queries
      .upsertDispatchCandidate(db)
      .run(randomUUID(), repoId, 5, "Issue 5 again", "u", "t");
    const rows = db
      .prepare("SELECT * FROM issue_dispatches WHERE issue_number = 5")
      .all();
    expect(rows.length).toBe(1); // OR IGNORE hit the partial unique index
  });

  it("local tasks (issue_number 0) never collide", () => {
    queries
      .insertLocalTask(db)
      .run(
        randomUUID(),
        repoId,
        "Task A",
        "body A",
        "t",
        null,
        null,
        "pending"
      );
    queries
      .insertLocalTask(db)
      .run(
        randomUUID(),
        repoId,
        "Task B",
        "body B",
        "t",
        null,
        null,
        "pending"
      );
    const rows = db
      .prepare("SELECT * FROM issue_dispatches WHERE source = 'local'")
      .all() as IssueDispatch[];
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.issue_number === 0)).toBe(true);
    expect(rows.map((r) => r.task_body).sort()).toEqual(["body A", "body B"]);
  });

  it("the gh dedupe lookup finds the GitHub row, never a local one", () => {
    queries
      .upsertDispatchCandidate(db)
      .run(randomUUID(), repoId, 7, "Issue 7", "u", "t");
    queries
      .insertLocalTask(db)
      .run(randomUUID(), repoId, "Task", "b", "t", null, null, "pending");
    const gh = queries
      .getDispatchByRepoIssue(db)
      .get(repoId, 7) as IssueDispatch;
    expect(gh.issue_number).toBe(7);
    expect(gh.source).toBe("github");
  });

  it("a local task can be scheduled (status + scheduled_at)", () => {
    queries
      .insertLocalTask(db)
      .run(
        randomUUID(),
        repoId,
        "Later",
        "b",
        "t",
        "2026-07-01T00:00:00Z",
        null,
        "scheduled"
      );
    const row = db
      .prepare("SELECT * FROM issue_dispatches WHERE source = 'local'")
      .get() as IssueDispatch;
    expect(row.status).toBe("scheduled");
    expect(row.scheduled_at).toBe("2026-07-01T00:00:00Z");
  });
});

// The fresh-schema path above no-ops migration 28's DROP/CREATE (createSchema
// already builds the partial index). This locks the actual UPGRADE path: an old
// DB carrying the pre-28 FULL unique index + no source/task_body columns.
describe("migration 28 — upgrade from a pre-28 database", () => {
  it("swaps to the partial index + backfills source, with no data loss", () => {
    const old = new Database(":memory:");
    // Minimal PRE-28 shape: issue_number NOT NULL, the OLD non-partial unique
    // index, and NO source/task_body columns.
    // issue_dispatches with the OLD full index + a minimal repo_lessons (later
    // migrations 29/30 ALTER these; runMigrations runs every pending migration,
    // so the fixture needs the tables those touch).
    old.exec(`
      CREATE TABLE issue_dispatches (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        issue_title TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE UNIQUE INDEX idx_dispatch_repo_issue ON issue_dispatches(repo_id, issue_number);
      CREATE TABLE repo_lessons (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        lens TEXT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);
    // Pretend migrations 1..27 already ran so runMigrations applies ONLY 28.
    const mark = old.prepare(
      "INSERT INTO _migrations (id, name) VALUES (?, ?)"
    );
    for (let i = 1; i <= 27; i++) mark.run(i, `legacy-${i}`);
    // A pre-existing GitHub row.
    old
      .prepare(
        "INSERT INTO issue_dispatches (id, repo_id, issue_number, status) VALUES ('d1','r1',5,'pending')"
      )
      .run();

    runMigrations(old); // applies ONLY migration 28

    // source column added + the existing row backfilled to 'github'.
    const row = old
      .prepare("SELECT source FROM issue_dispatches WHERE id='d1'")
      .get() as { source: string };
    expect(row.source).toBe("github");

    // gh dedupe still holds on the new partial index.
    old
      .prepare(
        "INSERT OR IGNORE INTO issue_dispatches (id, repo_id, issue_number, status) VALUES ('d2','r1',5,'pending')"
      )
      .run();
    const ghCount = old
      .prepare("SELECT COUNT(*) n FROM issue_dispatches WHERE issue_number=5")
      .get() as { n: number };
    expect(ghCount.n).toBe(1);

    // Two local tasks (issue_number 0) coexist — excluded from the partial index.
    old
      .prepare(
        "INSERT INTO issue_dispatches (id, repo_id, issue_number, source, status) VALUES ('l1','r1',0,'local','pending')"
      )
      .run();
    old
      .prepare(
        "INSERT INTO issue_dispatches (id, repo_id, issue_number, source, status) VALUES ('l2','r1',0,'local','pending')"
      )
      .run();
    const localCount = old
      .prepare("SELECT COUNT(*) n FROM issue_dispatches WHERE source='local'")
      .get() as { n: number };
    expect(localCount.n).toBe(2);

    old.close();
  });
});
