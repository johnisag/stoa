import { describe, it, expect } from "vitest";
import {
  classifySession,
  classifySessionsForKanban,
  type KanbanClassificationInput,
} from "@/lib/kanban";

const mk = (
  id: string,
  overrides: Partial<KanbanClassificationInput> = {}
): KanbanClassificationInput => ({
  id,
  status: "idle",
  ...overrides,
});

describe("classifySession", () => {
  it("sends completed Fleet workers to done", () => {
    expect(classifySession(mk("s1", { workerStatus: "completed" }))).toBe(
      "done"
    );
  });

  it("sends failed Fleet workers to done", () => {
    expect(classifySession(mk("s1", { workerStatus: "failed" }))).toBe("done");
  });

  it("sends running Fleet workers to in-progress", () => {
    expect(classifySession(mk("s1", { workerStatus: "running" }))).toBe(
      "in-progress"
    );
  });

  it("sends pending Fleet workers to in-progress", () => {
    expect(classifySession(mk("s1", { workerStatus: "pending" }))).toBe(
      "in-progress"
    );
  });

  it("sends merged PRs to done", () => {
    expect(classifySession(mk("s1", { prStatus: "merged" }))).toBe("done");
  });

  it("sends closed PRs to done", () => {
    expect(classifySession(mk("s1", { prStatus: "closed" }))).toBe("done");
  });

  it("sends open PRs to review", () => {
    expect(classifySession(mk("s1", { prStatus: "open" }))).toBe("review");
  });

  it("sends running status to in-progress", () => {
    expect(classifySession(mk("s1", { status: "running" }))).toBe(
      "in-progress"
    );
  });

  it("sends waiting status to in-progress", () => {
    expect(classifySession(mk("s1", { status: "waiting" }))).toBe(
      "in-progress"
    );
  });

  it("sends error status to blocked (needs attention)", () => {
    expect(classifySession(mk("s1", { status: "error" }))).toBe("blocked");
  });

  it("sends idle status to done", () => {
    expect(classifySession(mk("s1", { status: "idle" }))).toBe("done");
  });

  it("sends dead status to done (not backlog)", () => {
    expect(classifySession(mk("s1", { status: "dead" }))).toBe("done");
  });

  it("sends undefined status to backlog", () => {
    expect(classifySession(mk("s1", { status: undefined }))).toBe("backlog");
  });

  it("open PR overrides completed worker status → review, not done", () => {
    expect(
      classifySession(mk("s1", { workerStatus: "completed", prStatus: "open" }))
    ).toBe("review");
  });

  it("open PR overrides failed worker status → review, not done", () => {
    expect(
      classifySession(mk("s1", { workerStatus: "failed", prStatus: "open" }))
    ).toBe("review");
  });

  it("open PR overrides error status → review, not blocked", () => {
    expect(
      classifySession(mk("s1", { status: "error", prStatus: "open" }))
    ).toBe("review");
  });
});

describe("classifySessionsForKanban", () => {
  it("returns five columns in order", () => {
    const columns = classifySessionsForKanban([]);
    expect(columns).toHaveLength(5);
    expect(columns[0].id).toBe("backlog");
    expect(columns[1].id).toBe("in-progress");
    expect(columns[2].id).toBe("blocked");
    expect(columns[3].id).toBe("review");
    expect(columns[4].id).toBe("done");
  });

  it("distributes sessions across columns", () => {
    const sessions = [
      mk("s1", { status: "running" }), // in-progress
      mk("s2", { status: "idle" }), // done
      mk("s3", { prStatus: "open" }), // review
      mk("s4", { status: "error" }), // blocked
      mk("s5", { status: "waiting" }), // in-progress
      mk("s6", { workerStatus: "completed" }), // done
      mk("s7", { status: "dead" }), // done
    ];
    const columns = classifySessionsForKanban(sessions);
    expect(columns[0].sessionIds).toEqual([]); // backlog (empty)
    expect(columns[1].sessionIds).toEqual(["s1", "s5"]); // in-progress
    expect(columns[2].sessionIds).toEqual(["s4"]); // blocked
    expect(columns[3].sessionIds).toEqual(["s3"]); // review
    expect(columns[4].sessionIds).toEqual(["s2", "s6", "s7"]); // done
  });

  it("handles empty input", () => {
    const columns = classifySessionsForKanban([]);
    expect(columns.every((c) => c.sessionIds.length === 0)).toBe(true);
  });

  it("open PR overrides everything", () => {
    const sessions = [
      mk("s1", { status: "running", prStatus: "open" }), // → review
      mk("s2", { status: "idle", prStatus: "merged" }), // → done
      mk("s3", { status: "error", prStatus: "open" }), // → review (PR wins)
      mk("s4", { workerStatus: "failed", prStatus: "open" }), // → review
    ];
    const columns = classifySessionsForKanban(sessions);
    expect(columns[3].sessionIds).toEqual(["s1", "s3", "s4"]); // review
    expect(columns[4].sessionIds).toEqual(["s2"]); // done
  });
});
