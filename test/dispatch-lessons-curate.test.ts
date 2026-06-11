/**
 * Fleet memory #9 — operator-curated manual rules vs auto-captured findings.
 * Real in-memory SQLite so the source-aware SQL (forget-findings keeps manual,
 * promote-to-manual, manual-first injection ordering) is exercised, not mocked.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db";

describe("fleet memory — manual vs auto lessons", () => {
  let db: InstanceType<typeof Database>;
  const repoId = "r1";

  beforeAll(() => {
    db = new Database(":memory:");
    createSchema(db);
    runMigrations(db);
  });

  beforeEach(() => {
    db.exec("DELETE FROM repo_lessons; DELETE FROM dispatch_repos;");
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

  const addAuto = (text: string) =>
    queries
      .insertLessonIfNew(db)
      .run(randomUUID(), repoId, "correctness", text, repoId, text);
  const addManual = (text: string) =>
    queries
      .insertManualLesson(db)
      .run(randomUUID(), repoId, null, text, repoId, text);
  const all = () =>
    queries.listLessonsForRepo(db).all(repoId) as {
      text: string;
      source: string;
    }[];

  it("'forget findings' clears auto findings but KEEPS manual rules", () => {
    addAuto("a critic finding");
    addManual("use execFile, never exec");
    queries.clearLessonsForRepo(db).run(repoId);
    const rows = all();
    expect(rows.map((r) => r.text)).toEqual(["use execFile, never exec"]);
    expect(rows[0].source).toBe("manual");
  });

  it("markLessonManual promotes a matching finding so it survives forget", () => {
    addAuto("never split a path on '/'");
    expect(
      queries.markLessonManual(db).run(repoId, "never split a path on '/'")
        .changes
    ).toBe(1);
    expect(
      queries.markLessonManual(db).run(repoId, "no such text").changes
    ).toBe(0);

    queries.clearLessonsForRepo(db).run(repoId);
    const rows = all();
    expect(rows.map((r) => r.text)).toEqual(["never split a path on '/'"]);
    expect(rows[0].source).toBe("manual");
  });

  it("injects manual rules FIRST, then recent findings", () => {
    addAuto("finding one");
    addAuto("finding two");
    addManual("the curated rule");
    const recent = queries.listRecentLessons(db).all(repoId, 8) as {
      text: string;
    }[];
    expect(recent[0].text).toBe("the curated rule"); // manual first
    expect(recent.map((r) => r.text).sort()).toEqual([
      "finding one",
      "finding two",
      "the curated rule",
    ]);
  });

  it("remembering the same rule twice is idempotent (no duplicate)", () => {
    addManual("one rule");
    addManual("one rule");
    expect(queries.listLessonsForRepo(db).all(repoId)).toHaveLength(1);
  });

  it("a manual rule is removable individually (deleteLesson)", () => {
    addManual("temporary rule");
    const rows = queries.listLessonsForRepo(db).all(repoId) as {
      id: string;
      source: string;
    }[];
    expect(rows[0].source).toBe("manual");
    queries.deleteLesson(db).run(rows[0].id, repoId);
    expect(queries.listLessonsForRepo(db).all(repoId)).toHaveLength(0);
  });
});
