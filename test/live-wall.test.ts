/**
 * Live-wall pure helpers — which sessions land on the wall, and the grid column
 * count. No I/O, no React.
 */
import { describe, it, expect } from "vitest";
import {
  liveWallSessions,
  liveWallColumns,
  LIVE_WALL_MAX_COLUMNS,
} from "@/lib/live-wall";
import type { Session } from "@/lib/db";

// A minimal Session for the wall filter (only the fields the helper reads).
function sess(over: Partial<Session>): Session {
  return {
    id: over.id ?? "s",
    name: over.name ?? "agent",
    tmux_name: over.tmux_name ?? "key-" + (over.id ?? "s"),
    status: over.status ?? "idle",
    agent_type: over.agent_type ?? "claude",
    worker_status: over.worker_status ?? null,
    ...over,
  } as Session;
}

describe("liveWallSessions", () => {
  it("keeps attachable, in-play sessions (have a backend key, not finished)", () => {
    const list = [
      sess({ id: "a" }),
      sess({ id: "b", worker_status: "running" }),
    ];
    expect(liveWallSessions(list).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("drops a session with no backend key (nothing to attach to)", () => {
    const list = [sess({ id: "a" }), sess({ id: "keyless", tmux_name: "" })];
    expect(liveWallSessions(list).map((s) => s.id)).toEqual(["a"]);
  });

  it("keeps a running worker and a plain session (worker_status null)", () => {
    const list = [
      sess({ id: "plain", worker_status: null }),
      sess({ id: "running", worker_status: "running" }),
    ];
    expect(liveWallSessions(list).map((s) => s.id)).toEqual([
      "plain",
      "running",
    ]);
  });

  it("drops not-yet-live (pending) and finished (completed/failed) workers", () => {
    const list = [
      sess({ id: "a" }),
      // pending: has a tmux_name but no pty yet → its observer attach would error.
      sess({ id: "pending", worker_status: "pending" }),
      sess({ id: "done", worker_status: "completed" }),
      sess({ id: "failed", worker_status: "failed" }),
    ];
    expect(liveWallSessions(list).map((s) => s.id)).toEqual(["a"]);
  });

  it("preserves input order (the sidebar order)", () => {
    const list = [sess({ id: "z" }), sess({ id: "a" }), sess({ id: "m" })];
    expect(liveWallSessions(list).map((s) => s.id)).toEqual(["z", "a", "m"]);
  });
});

describe("liveWallColumns", () => {
  it("is roughly square, at least 1, capped at the max", () => {
    expect(liveWallColumns(0)).toBe(1);
    expect(liveWallColumns(1)).toBe(1);
    expect(liveWallColumns(2)).toBe(2);
    expect(liveWallColumns(3)).toBe(2);
    expect(liveWallColumns(4)).toBe(2);
    expect(liveWallColumns(6)).toBe(3);
    expect(liveWallColumns(9)).toBe(3);
    expect(liveWallColumns(10)).toBe(4);
    expect(liveWallColumns(11)).toBe(4);
    expect(liveWallColumns(12)).toBe(4);
    expect(liveWallColumns(100)).toBe(LIVE_WALL_MAX_COLUMNS);
  });
});
