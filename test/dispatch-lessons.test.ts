/**
 * Fleet memory — the lessons ledger. buildLessonsBlock is pure (the prompt block);
 * captureLessons records only the BLOCKING findings (de-duped via the SQL), and
 * getLessonsBlock renders the recent ones. Mocks the db + the findings reader.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    findings: [] as Array<{ lens: string; verdict: string; text: string }>,
    inserted: [] as Array<{ repoId: string; lens: string; text: string }>,
    recent: [] as Array<{ lens: string | null; text: string }>,
  },
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    insertLessonIfNew: () => ({
      run: (_id: string, repoId: string, lens: string, text: string) =>
        state.inserted.push({ repoId, lens, text }),
    }),
    listRecentLessons: () => ({ all: () => state.recent }),
  },
}));
vi.mock("@/lib/platform", () => ({ expandHome: (p: string) => p }));
vi.mock("@/lib/dispatch/reviewer", () => ({
  readReviewerFindings: async () => state.findings,
}));

import {
  buildLessonsBlock,
  getLessonsBlock,
  captureLessons,
} from "../lib/dispatch/lessons";
import type { DispatchRepo, IssueDispatch } from "../lib/dispatch/types";

describe("buildLessonsBlock", () => {
  it("renders bullets with lens tags", () => {
    const block = buildLessonsBlock([
      { lens: "correctness", text: "off-by-one in the loop bound" },
      { lens: null, text: "missing await on the async call" },
    ]);
    expect(block).toContain("KNOWN PITFALLS");
    expect(block).toContain("- [correctness] off-by-one in the loop bound");
    expect(block).toContain("- missing await on the async call");
  });

  it("is empty when there are no lessons (safe to always concatenate)", () => {
    expect(buildLessonsBlock([])).toBe("");
  });
});

describe("getLessonsBlock", () => {
  beforeEach(() => {
    state.recent = [];
  });
  it("renders the repo's recent lessons; empty when none", () => {
    expect(getLessonsBlock("r1")).toBe("");
    state.recent = [{ lens: "perf", text: "N+1 query in the list endpoint" }];
    expect(getLessonsBlock("r1")).toContain("N+1 query");
  });
});

describe("captureLessons", () => {
  const repo = { id: "r1" } as DispatchRepo;
  const d = { pr_number: 7, worktree_path: "/wt" } as IssueDispatch;

  beforeEach(() => {
    state.findings = [];
    state.inserted = [];
  });

  it("records ONLY blocking (REQUEST_CHANGES) findings, truncated", async () => {
    state.findings = [
      { lens: "correctness", verdict: "REQUEST_CHANGES", text: "a real bug" },
      { lens: "simplicity", verdict: "APPROVE", text: "looks fine" },
      { lens: "perf", verdict: "REQUEST_CHANGES", text: "x".repeat(500) },
    ];
    await captureLessons(repo, d);
    expect(state.inserted.map((i) => i.lens)).toEqual(["correctness", "perf"]);
    expect(state.inserted[0].text).toBe("a real bug");
    expect(state.inserted[1].text.length).toBe(280); // capped
  });

  it("does nothing for a row with no PR / worktree", async () => {
    await captureLessons(repo, { pr_number: null } as IssueDispatch);
    expect(state.inserted).toHaveLength(0);
  });
});
