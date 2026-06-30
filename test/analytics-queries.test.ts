/**
 * Analytics query layer — integration test against a real in-memory SQLite (real
 * schema + migrations + queries), with getDb() mocked to it and the cost
 * estimator stubbed (no transcripts on disk in CI). Asserts the join from the
 * audit ledger + sessions + dispatch outcomes into a coherent report, and that
 * the window filter + windowDays normalization behave.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => state.db };
});
// Stub the cost estimator — it reads Claude transcripts off disk, absent in CI.
vi.mock("@/lib/session-cost", () => ({
  computeSessionCosts: vi.fn(async () => ({})),
}));

import { queries } from "@/lib/db";
import { computeSessionCosts } from "@/lib/session-cost";
import {
  getAnalyticsReport,
  normalizeWindowDays,
} from "@/lib/analytics/queries";

function db() {
  return state.db as InstanceType<typeof Database>;
}

const NOW = Date.parse("2026-06-15T12:00:00Z");
const DAY = 86_400_000;

/** Insert a session row. created_at/updated_at are SQLite UTC datetime strings. */
function addSession(
  id: string,
  over: {
    tmux_name?: string;
    agent_type?: string;
    model?: string;
    status?: string;
    createdMsAgo?: number;
    pr_status?: string | null;
  } = {}
) {
  const createdMs = NOW - (over.createdMsAgo ?? DAY);
  const dt = new Date(createdMs).toISOString().slice(0, 19).replace("T", " ");
  db()
    .prepare(
      `INSERT INTO sessions (id, name, tmux_name, agent_type, model, status, working_directory, created_at, updated_at, pr_status)
       VALUES (?, ?, ?, ?, ?, ?, '~', ?, ?, ?)`
    )
    .run(
      id,
      id,
      over.tmux_name ?? `claude-${id}`,
      over.agent_type ?? "claude",
      over.model ?? "sonnet",
      over.status ?? "idle",
      dt,
      dt,
      over.pr_status ?? null
    );
}

function addEvent(
  key: string,
  type: string,
  atMs: number,
  payload: Record<string, unknown> | null = null
) {
  queries
    .appendSessionEvent(db())
    .run(key, type, payload ? JSON.stringify(payload) : null, atMs);
}

beforeAll(() => {
  const d = new Database(":memory:");
  createSchema(d);
  runMigrations(d);
  state.db = d;
});

beforeEach(() => {
  db().exec(
    "DELETE FROM session_events; DELETE FROM sessions; DELETE FROM issue_dispatches; DELETE FROM dispatch_repos;"
  );
  vi.clearAllMocks();
  vi.mocked(computeSessionCosts).mockResolvedValue({});
});

describe("normalizeWindowDays", () => {
  it("defaults, floors, and clamps", () => {
    expect(normalizeWindowDays(undefined)).toBe(14);
    expect(normalizeWindowDays("7")).toBe(7);
    expect(normalizeWindowDays("0")).toBe(14); // <1 => default
    expect(normalizeWindowDays("9999")).toBe(90); // clamp to max
    expect(normalizeWindowDays("abc")).toBe(14);
  });
});

describe("getAnalyticsReport", () => {
  it("joins ledger events to sessions on the backend key", async () => {
    addSession("a", { tmux_name: "claude-a" });
    addEvent("claude-a", "session_create", NOW - 5000);
    addEvent("claude-a", "input_text", NOW - 4000, { length: 5 });
    addEvent("claude-a", "input_paste", NOW - 3000, { length: 99 });

    const r = await getAnalyticsReport(14, NOW);
    expect(r.performance.sessionCount).toBe(1);
    expect(r.performance.activeSessionCount).toBe(1);
    expect(r.performance.totalInputEvents).toBe(2); // text + paste
    expect(
      r.behavioural.eventMix.find((e) => e.type === "input_paste")?.count
    ).toBe(1);
  });

  it("counts a pty session's events keyed by the canonical backend key (null tmux_name)", async () => {
    // Regression for #6: a pty session has NO tmux_name, so its events are stored
    // under {provider}-{id} ("claude-p"). The old lookup (tmux_name || name) used
    // the display name ("p") and missed them — so a long-lived pty session active
    // in-window was dropped and its events never counted. Created 40d ago (outside
    // the window) on purpose: it can ONLY be included via its in-window activity,
    // which requires the backend-key lookup to match.
    addSession("p", { tmux_name: "", createdMsAgo: 40 * DAY });
    addEvent("claude-p", "input_text", NOW - 1 * DAY, { length: 2 });

    const r = await getAnalyticsReport(14, NOW);
    expect(r.performance.sessionCount).toBe(1);
    expect(r.performance.totalInputEvents).toBe(1);
  });

  it("excludes sessions created before the window", async () => {
    addSession("old", { createdMsAgo: 40 * DAY }); // outside a 14d window
    addSession("new", { createdMsAgo: 1 * DAY });
    addEvent("claude-new", "input_text", NOW - 1000, { length: 1 });

    const r = await getAnalyticsReport(14, NOW);
    expect(r.performance.sessionCount).toBe(1); // only "new"
  });

  it("INCLUDES a long-lived session created before the window but active within it", async () => {
    // Created 40d ago (outside a 14d window) but produced an event yesterday —
    // it must still appear, not be dropped for being old (the activity-window fix).
    addSession("longlived", {
      tmux_name: "claude-longlived",
      createdMsAgo: 40 * DAY,
    });
    addEvent("claude-longlived", "input_text", NOW - 1 * DAY, { length: 3 });

    const r = await getAnalyticsReport(14, NOW);
    expect(r.performance.sessionCount).toBe(1);
    expect(r.performance.totalInputEvents).toBe(1);
  });

  it("does not double-count events outside the window for an in-window session", async () => {
    addSession("s", { tmux_name: "claude-s", createdMsAgo: 1 * DAY });
    addEvent("claude-s", "input_text", NOW - 1000, { length: 1 }); // in window
    addEvent("claude-s", "input_text", NOW - 40 * DAY, { length: 1 }); // old

    const r = await getAnalyticsReport(14, NOW);
    expect(r.performance.totalInputEvents).toBe(1); // only the in-window event
  });

  it("attaches dispatch outcome signals (merged + review decision)", async () => {
    addSession("w", { tmux_name: "claude-w", agent_type: "claude" });
    addEvent("claude-w", "input_text", NOW - 1000, { length: 1 });
    // A dispatch repo + an issue_dispatch row pointing at the session.
    db()
      .prepare(
        `INSERT INTO dispatch_repos (id, repo_path, repo_slug) VALUES ('r1', '/tmp/r', 'o/r')`
      )
      .run();
    db()
      .prepare(
        `INSERT INTO issue_dispatches (id, repo_id, issue_number, status, session_id, review_decision)
         VALUES ('d1', 'r1', 1, 'merged', 'w', 'APPROVED')`
      )
      .run();

    const r = await getAnalyticsReport(14, NOW);
    expect(r.performance.mergedPrCount).toBe(1);
    const claude = r.intelligence.find((p) => p.agent === "claude")!;
    expect(claude.mergedPrCount).toBe(1);
    expect(claude.reviewerPassRate).toBe(1); // 1 approved / 1 reviewed
  });

  it("folds in cost from the estimator (keyed by session id)", async () => {
    addSession("c", { tmux_name: "claude-c" });
    addEvent("claude-c", "input_text", NOW - 1000, { length: 1 });
    vi.mocked(computeSessionCosts).mockResolvedValue({
      c: {
        name: "c",
        model: "sonnet",
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        costUsd: 2.5,
        contextTokens: 100,
        supported: true,
      },
    });

    const r = await getAnalyticsReport(14, NOW);
    expect(r.performance.totalCostUsd).toBe(2.5);
    expect(r.performance.totalTokens).toBe(150);
  });

  it("returns an empty-but-valid report when there is no data", async () => {
    const r = await getAnalyticsReport(14, NOW);
    expect(r.performance.sessionCount).toBe(0);
    expect(r.issues).toEqual([]);
    expect(r.trends.points.length).toBe(14); // dense axis even with no data
  });
});
