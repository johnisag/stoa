import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IssueDispatch } from "@/lib/dispatch/types";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// reconcileOneStale reads a PR's state via getPrReadiness (mocked → state only) and
// writes the resolved status via resolveStaleDispatch (mocked to RECORD the write;
// the query's own WHERE status='pr_open' race guard is locked separately against a
// real sqlite in dispatch-resolve-stale.test.ts). The "boom" id makes the mocked
// write throw, exercising the loop's per-row error isolation. No gh, no fs — the
// pure mapping is exercised through the real reconcile.
const { state } = vi.hoisted(() => ({
  state: {
    rows: [] as IssueDispatch[],
    repo: undefined as { repo_path: string; repo_slug: string } | undefined,
    prState: null as string | null,
    writes: [] as Array<unknown[]>,
  },
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    listPrOpen: () => ({ all: () => state.rows }),
    getDispatchRepo: () => ({ get: () => state.repo }),
    resolveStaleDispatch: () => ({
      run: (status: unknown, id: unknown) => {
        if (id === "boom") throw new Error("db write failed");
        state.writes.push([status, id]);
      },
    }),
  },
}));

vi.mock("@/lib/dispatch/auto-merge", () => ({
  getPrReadiness: async () => ({
    mergeable: null,
    checks: "none",
    headRefOid: null,
    state: state.prState,
  }),
}));

import {
  probeFromState,
  nextStaleAction,
  reconcileOneStale,
  reconcileStaleDispatches,
} from "@/lib/dispatch/stale";

const db = {} as Parameters<typeof reconcileOneStale>[0];
const row = (over: Record<string, unknown> = {}): IssueDispatch =>
  ({
    id: "d1",
    repo_id: "r1",
    status: "pr_open",
    pr_number: 7,
    worktree_path: "/wt",
    ...over,
  }) as unknown as IssueDispatch;

describe("probeFromState — gh state → probe (null = indeterminate)", () => {
  it("maps a definite state", () => {
    expect(probeFromState("MERGED")).toBe("merged");
    expect(probeFromState("CLOSED")).toBe("closed");
    expect(probeFromState("OPEN")).toBe("open");
    expect(probeFromState("merged")).toBe("merged"); // case-insensitive
  });

  it("treats null (gh failed / no state) as 'error' — never a false resolution", () => {
    expect(probeFromState(null)).toBe("error");
  });

  it("treats an unknown live state as still-open (never merged/closed)", () => {
    expect(probeFromState("LOCKED")).toBe("open");
  });
});

describe("nextStaleAction — pure resolution from the probe", () => {
  it("resolves merged/closed, and fails open on open/error", () => {
    expect(nextStaleAction("merged")).toBe("merged");
    expect(nextStaleAction("closed")).toBe("cancelled");
    expect(nextStaleAction("open")).toBe("noop");
    expect(nextStaleAction("error")).toBe("noop"); // FAIL OPEN
  });
});

describe("reconcileOneStale", () => {
  beforeEach(() => {
    state.repo = { repo_path: "/repo", repo_slug: "owner/repo" };
    state.writes = [];
  });

  it("merged out of band → resolves merged (guarded write)", async () => {
    state.prState = "MERGED";
    expect(await reconcileOneStale(db, row())).toEqual({
      resolution: "merged",
      probe: "merged",
    });
    expect(state.writes).toEqual([["merged", "d1"]]);
  });

  it("closed out of band → resolves cancelled", async () => {
    state.prState = "CLOSED";
    expect(await reconcileOneStale(db, row())).toEqual({
      resolution: "cancelled",
      probe: "closed",
    });
    expect(state.writes).toEqual([["cancelled", "d1"]]);
  });

  it("still open → noop, no write (probe 'open' so the UI can say 'still open')", async () => {
    state.prState = "OPEN";
    expect(await reconcileOneStale(db, row())).toEqual({
      resolution: "noop",
      probe: "open",
    });
    expect(state.writes).toHaveLength(0);
  });

  it("gh indeterminate → noop with probe 'error' (fail-open; UI says 'couldn't check')", async () => {
    state.prState = null;
    expect(await reconcileOneStale(db, row())).toEqual({
      resolution: "noop",
      probe: "error",
    });
    expect(state.writes).toHaveLength(0);
  });

  it("a row without a pr_number is left alone (no probe, no write)", async () => {
    state.prState = "MERGED";
    expect(await reconcileOneStale(db, row({ pr_number: null }))).toEqual({
      resolution: "noop",
      probe: "error",
    });
    expect(state.writes).toHaveLength(0);
  });

  it("resolves even when the tracked repo is gone (reads via the worktree cwd)", async () => {
    state.repo = undefined;
    state.prState = "MERGED";
    expect((await reconcileOneStale(db, row())).resolution).toBe("merged");
    expect(state.writes).toEqual([["merged", "d1"]]);
  });
});

describe("reconcileStaleDispatches", () => {
  beforeEach(() => {
    state.repo = { repo_path: "/repo", repo_slug: "owner/repo" };
    state.rows = [];
    state.writes = [];
  });

  it("no-ops cleanly when there are no open-PR rows", async () => {
    await expect(reconcileStaleDispatches()).resolves.toBeUndefined();
    expect(state.writes).toHaveLength(0);
  });

  it("reconciles every open-PR row against GitHub", async () => {
    state.rows = [row({ id: "a" }), row({ id: "b" })];
    state.prState = "MERGED";
    await reconcileStaleDispatches();
    expect(state.writes).toEqual([
      ["merged", "a"],
      ["merged", "b"],
    ]);
  });

  it("one row's failure never aborts the rest", async () => {
    state.rows = [row({ id: "boom" }), row({ id: "ok" })];
    state.prState = "MERGED";
    await expect(reconcileStaleDispatches()).resolves.toBeUndefined();
    expect(state.writes).toContainEqual(["merged", "ok"]);
  });
});
