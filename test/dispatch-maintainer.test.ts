/**
 * Autonomous maintainer (v1). The pure core — buildSurveyPrompt (load-bearing
 * instructions locked), parseSurvey (fail-closed, last-block-wins, rationale
 * REQUIRED, empty = valid "nothing to do"), buildMaintainerTaskBody — plus the
 * cadence due-math (isRecurrenceDue) and the DB-level SAFETY FENCE: a
 * maintainer-proposed row is excluded from the auto-dispatch query but still
 * visible to the backlog/approve path. The reconciler-integration fence lives in
 * dispatch-reconciler.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db";
import {
  buildSurveyPrompt,
  parseSurvey,
  buildMaintainerTaskBody,
} from "@/lib/dispatch/maintainer";
import { maintainerWhy } from "@/lib/dispatch/task-label";
import type { DispatchRepo, IssueDispatch } from "@/lib/dispatch/types";

const wrap = (json: string) =>
  `prose…\nSTOA_SURVEY_BEGIN\n${json}\nSTOA_SURVEY_END\ntrailing`;

const task = (over: Record<string, unknown> = {}) => ({
  title: "Fix flaky test",
  body: "The test retries — stabilize it.",
  rationale: "test/foo.test.ts:42 fails intermittently",
  rank: 1,
  ...over,
});

describe("buildSurveyPrompt", () => {
  it("contains the load-bearing instructions, goal, cap, markers, and artifact", () => {
    const p = buildSurveyPrompt(
      { base_branch: "main" },
      "keep CI green",
      [],
      5,
      "SURVEY-abc123.md"
    );
    expect(p).toContain("STOA_SURVEY_BEGIN");
    expect(p).toContain("STOA_SURVEY_END");
    expect(p).toMatch(/READ-ONLY/i);
    expect(p).toMatch(/do not commit/i);
    expect(p).toContain("keep CI green");
    expect(p).toContain("5");
    expect(p).toContain("main");
    // The per-run artifact name (not a bare SURVEY.md) is what it must write to.
    expect(p).toContain("SURVEY-abc123.md");
    // The empty-answer escape hatch must be advertised.
    expect(p).toContain('{"tasks":[]}');
    // Investigation signals it should gather before proposing.
    expect(p).toMatch(/gh issue list/);
    expect(p).toMatch(/npm outdated/);
    expect(p).toMatch(/rationale/i);
  });

  it("embeds the verbatim open-task dedup list when present", () => {
    const p = buildSurveyPrompt(
      { base_branch: "dev" },
      "goal",
      [
        { title: "Bump eslint", bodyFirstLine: "eslint is two majors behind" },
        { title: "Triage #88", bodyFirstLine: "" },
      ],
      3,
      "SURVEY-x.md"
    );
    expect(p).toMatch(/ALREADY EXIST/i);
    expect(p).toContain("Bump eslint");
    expect(p).toContain("eslint is two majors behind");
    expect(p).toContain("Triage #88");
  });

  it("omits the dedup block entirely when no open tasks", () => {
    const p = buildSurveyPrompt({ base_branch: "main" }, "goal", [], 5, "S.md");
    expect(p).not.toMatch(/ALREADY EXIST/i);
  });
});

describe("parseSurvey", () => {
  it("parses a well-formed block and sorts by rank ascending", () => {
    const r = parseSurvey(
      wrap(
        JSON.stringify({
          tasks: [task({ title: "B", rank: 3 }), task({ title: "A", rank: 1 })],
        })
      )
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tasks.map((t) => t.title)).toEqual(["A", "B"]);
      expect(r.tasks[0].rationale).toContain("test/foo.test.ts:42");
    }
  });

  it("treats an EMPTY tasks array as a valid 'nothing to do' answer", () => {
    const r = parseSurvey(wrap('{"tasks":[]}'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tasks).toEqual([]);
  });

  it("takes the LAST block when two are present (latest-wins)", () => {
    const text =
      wrap(JSON.stringify({ tasks: [task({ title: "OLD" })] })) +
      "\n" +
      wrap(JSON.stringify({ tasks: [task({ title: "NEW" })] }));
    const r = parseSurvey(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tasks[0].title).toBe("NEW");
  });

  it("REJECTS a rationale-less task (the operator must see WHY)", () => {
    const r = parseSurvey(
      wrap(JSON.stringify({ tasks: [task({ rationale: "  " })] }))
    );
    expect(r.ok).toBe(false);
  });

  it("fails closed on every malformed shape", () => {
    expect(parseSurvey("").ok).toBe(false);
    expect(parseSurvey("no markers").ok).toBe(false);
    expect(parseSurvey("STOA_SURVEY_BEGIN\n{bad}\nSTOA_SURVEY_END").ok).toBe(
      false
    );
    expect(parseSurvey("STOA_SURVEY_BEGIN\n{}").ok).toBe(false); // no END marker
    expect(parseSurvey(wrap('{"nope":1}')).ok).toBe(false); // no tasks array
    expect(
      parseSurvey(wrap('{"tasks":[{"body":"x","rationale":"y"}]}')).ok
    ).toBe(false); // no title
    expect(
      parseSurvey(wrap('{"tasks":[{"title":"A","rationale":"y"}]}')).ok
    ).toBe(false); // no body
  });

  it("defaults a missing rank to the back of the list (rank 99)", () => {
    const r = parseSurvey(
      wrap(
        '{"tasks":[{"title":"A","body":"b","rationale":"r","rank":2},{"title":"Z","body":"b","rationale":"r"}]}'
      )
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tasks.map((t) => t.title)).toEqual(["A", "Z"]); // Z → 99
  });

  it("truncates oversized fields (a runaway survey can't persist a megabyte row)", () => {
    const huge = "x".repeat(60000);
    const r = parseSurvey(
      wrap(
        JSON.stringify({
          tasks: [task({ title: huge, body: huge, rationale: huge })],
        })
      )
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tasks[0].title.length).toBe(200);
      expect(r.tasks[0].rationale.length).toBe(1000);
      expect(r.tasks[0].body.length).toBe(20000);
    }
  });
});

describe("buildMaintainerTaskBody", () => {
  it("prefixes the rationale (visible inline) above the body", () => {
    const body = buildMaintainerTaskBody(
      task({ rationale: "eslint 2 majors behind", body: "Bump it." })
    );
    expect(body.startsWith("[maintainer] eslint 2 majors behind")).toBe(true);
    expect(body).toContain("Bump it.");
    expect(body).toContain("---");
  });
});

describe("maintainerWhy (rationale shown at the approve point)", () => {
  const row = (over: Partial<IssueDispatch>): IssueDispatch =>
    ({ maintainer_proposed: 0, task_body: null, ...over }) as IssueDispatch;

  it("extracts the rationale, stripping the [maintainer] prefix", () => {
    expect(
      maintainerWhy(
        row({
          maintainer_proposed: 1,
          task_body: buildMaintainerTaskBody(
            task({ rationale: "eslint 2 majors behind", body: "bump it" })
          ),
        })
      )
    ).toBe("eslint 2 majors behind");
  });

  it("is null for a non-maintainer row or an empty body", () => {
    expect(
      maintainerWhy(row({ task_body: "[maintainer] x\n\n---\ny" }))
    ).toBeNull();
    expect(
      maintainerWhy(row({ maintainer_proposed: 1, task_body: null }))
    ).toBeNull();
  });
});

// ── DB-level: the safety fence + dedup, against the real schema/migrations ──────
describe("maintainer DB fence + dedup", () => {
  let d: InstanceType<typeof Database>;
  let seq = 0;

  const addRepo = (): string => {
    const id = `repo-${seq++}`;
    queries
      .createDispatchRepo(d)
      .run(
        id,
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
        null
      );
    return id;
  };

  beforeAll(() => {
    d = new Database(":memory:");
    createSchema(d);
    runMigrations(d);
  });

  beforeEach(() => {
    d.exec("DELETE FROM issue_dispatches; DELETE FROM dispatch_repos;");
  });

  it("migration 31 adds the survey columns with safe defaults", () => {
    const id = addRepo();
    const repo = queries.getDispatchRepo(d).get(id) as DispatchRepo;
    expect(repo.maintainer_survey_enabled).toBe(0);
    expect(repo.maintainer_survey_goal).toBeNull();
    expect(repo.maintainer_survey_cadence).toBeNull();
    expect(repo.maintainer_survey_last_at).toBeNull();
  });

  it("insertMaintainerTask stores a pending local row carrying maintainer_proposed=1", () => {
    const repo = addRepo();
    queries
      .insertMaintainerTask(d)
      .run(
        "m1",
        repo,
        "Bump eslint",
        "[maintainer] stale\n\n---\ndo it",
        "2026-06-06T12:00:00Z"
      );
    const row = queries.getDispatch(d).get("m1") as IssueDispatch;
    expect(row.status).toBe("pending");
    expect(row.source).toBe("local");
    expect(row.issue_number).toBe(0);
    expect(row.maintainer_proposed).toBe(1);
    expect(row.task_body).toContain("[maintainer]");
  });

  it("THE FENCE: listPendingDispatchableForRepo excludes maintainer rows; the plain list includes them", () => {
    const repo = addRepo();
    // one normal pending, one maintainer-proposed pending
    queries
      .insertLocalTask(d)
      .run(
        "normal",
        repo,
        "Normal task",
        "body",
        "2026-06-06T10:00:00Z",
        null,
        null,
        "pending"
      );
    queries
      .insertMaintainerTask(d)
      .run(
        "maint",
        repo,
        "Maintainer task",
        "[maintainer] x",
        "2026-06-06T11:00:00Z"
      );

    const dispatchable = queries
      .listPendingDispatchableForRepo(d)
      .all(repo) as IssueDispatch[];
    expect(dispatchable.map((r) => r.id)).toEqual(["normal"]); // fenced

    const all = queries.listPendingForRepo(d).all(repo) as IssueDispatch[];
    expect(all.map((r) => r.id).sort()).toEqual(["maint", "normal"]); // both visible to approve
  });

  it("findOpenLocalTaskByTitle catches an exact-title dup but ignores closed rows", () => {
    const repo = addRepo();
    queries
      .insertMaintainerTask(d)
      .run("open", repo, "Dup title", "[maintainer] x", "2026-06-06T11:00:00Z");
    expect(
      queries.findOpenLocalTaskByTitle(d).get(repo, "Dup title")
    ).toBeTruthy();
    expect(
      queries.findOpenLocalTaskByTitle(d).get(repo, "Other title")
    ).toBeUndefined();

    // A cancelled row with the same title does NOT block re-proposing it.
    queries.updateDispatchStatus(d).run("cancelled", "open");
    expect(
      queries.findOpenLocalTaskByTitle(d).get(repo, "Dup title")
    ).toBeUndefined();
  });

  it("listOpenTasksForSurveyDedup returns open titles+bodies, capped", () => {
    const repo = addRepo();
    queries
      .insertLocalTask(d)
      .run(
        "a",
        repo,
        "Task A",
        "body A",
        "2026-06-06T10:00:00Z",
        null,
        null,
        "pending"
      );
    queries
      .insertMaintainerTask(d)
      .run("b", repo, "Task B", "body B", "2026-06-06T11:00:00Z");
    const rows = queries.listOpenTasksForSurveyDedup(d).all(repo, 10) as {
      issue_title: string;
      task_body: string;
    }[];
    const titles = rows.map((r) => r.issue_title).sort();
    expect(titles).toEqual(["Task A", "Task B"]);
  });
});
