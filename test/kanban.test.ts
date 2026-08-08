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

  it("sends error status to in-progress (needs attention)", () => {
    expect(classifySession(mk("s1", { status: "error" }))).toBe("in-progress");
  });

  it("sends idle status to done", () => {
    expect(classifySession(mk("s1", { status: "idle" }))).toBe("done");
  });

  it("sends dead status to backlog", () => {
    expect(classifySession(mk("s1", { status: "dead" }))).toBe("backlog");
  });

  it("sends undefined status to backlog", () => {
    expect(classifySession(mk("s1", { status: undefined }))).toBe("backlog");
  });
});

describe("classifySessionsForKanban", () => {
  it("returns four columns in order", () => {
    const columns = classifySessionsForKanban([]);
    expect(columns).toHaveLength(4);
    expect(columns[0].id).toBe("backlog");
    expect(columns[1].id).toBe("in-progress");
    expect(columns[2].id).toBe("review");
    expect(columns[3].id).toBe("done");
  });

  it("distributes sessions across columns", () => {
    const sessions = [
      mk("s1", { status: "running" }), // in-progress
      mk("s2", { status: "idle" }), // done
      mk("s3", { prStatus: "open" }), // review
      mk("s4", { status: "dead" }), // backlog
      mk("s5", { status: "waiting" }), // in-progress
      mk("s6", { workerStatus: "completed" }), // done
    ];
    const columns = classifySessionsForKanban(sessions);
    expect(columns[0].sessionIds).toEqual(["s4"]); // backlog
    expect(columns[1].sessionIds).toEqual(["s1", "s5"]); // in-progress
    expect(columns[2].sessionIds).toEqual(["s3"]); // review
    expect(columns[3].sessionIds).toEqual(["s2", "s6"]); // done
  });

  it("handles empty input", () => {
    const columns = classifySessionsForKanban([]);
    expect(columns.every((c) => c.sessionIds.length === 0)).toBe(true);
  });

  it("PR status overrides session status", () => {
    const sessions = [
      mk("s1", { status: "running", prStatus: "open" }), // → review (PR overrides)
      mk("s2", { status: "idle", prStatus: "merged" }), // → done
    ];
    const columns = classifySessionsForKanban(sessions);
    expect(columns[2].sessionIds).toEqual(["s1"]); // review
    expect(columns[3].sessionIds).toEqual(["s2"]); // done
  });

  it("worker_status overrides session status", () => {
    const sessions = [
      mk("s1", { status: "running", workerStatus: "completed" }), // → done
    ];
    const columns = classifySessionsForKanban(sessions);
    expect(columns[3].sessionIds).toEqual(["s1"]); // done
  });
});
