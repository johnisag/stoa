/**
 * Live-wall grid — pure helpers (no I/O, no React) for the read-only "wall of
 * agent terminals" view (#7). The view itself (components/views/LiveWallView) is
 * a CSS grid of read-only observer terminals (MiniTerminal) over Stoa's EXISTING
 * per-session WebSocket streams — no iframes, no polling (amux drove its wall from
 * self-embedding iframes that 5×-amplified its own request load; Stoa reuses the
 * live streams it already has).
 *
 * Which sessions land on the wall and how many columns to use are the only bits
 * worth testing, so they live here.
 */

import type { Session } from "@/lib/db";

/** Hard cap on grid columns — beyond this the cells get too small to read. */
export const LIVE_WALL_MAX_COLUMNS = 4;
/** Hard cap on cells — each cell opens an observer WebSocket, so bound the count
 * (a runaway fleet of 100 workers shouldn't open 100 sockets). The view shows a
 * "+N more" note when it trims. A square of the max columns is a natural ceiling. */
export const LIVE_WALL_MAX_CELLS =
  LIVE_WALL_MAX_COLUMNS * LIVE_WALL_MAX_COLUMNS;

/**
 * The sessions to show on the wall: those with a backend key (`tmux_name` — the
 * attach key the observer terminal needs, an empty string for a not-yet-spawned
 * row) that are actually LIVE. A worker that is pending (queued, no pty yet — its
 * observer attach would just error), completed, or failed is dropped; the wall is
 * for the agents that are running right now, not a queue or an archive. Order is
 * preserved (the caller passes the sidebar order), so the wall reads the same as
 * the session list. Pure. (The caller trims to LIVE_WALL_MAX_CELLS for display.)
 */
export function liveWallSessions(sessions: Session[]): Session[] {
  return sessions.filter(
    (s) =>
      !!s.tmux_name &&
      s.worker_status !== "pending" &&
      s.worker_status !== "completed" &&
      s.worker_status !== "failed"
  );
}

/**
 * A sensible column count for `count` cells: roughly square (ceil(sqrt)), at least
 * 1, capped at LIVE_WALL_MAX_COLUMNS so cells stay legible. 1→1, 2→2, 4→2, 6→3,
 * 9→3, 12→4, 30→4. Pure → unit-tested. The grid template is built from this.
 */
export function liveWallColumns(count: number): number {
  if (count <= 1) return 1;
  return Math.min(LIVE_WALL_MAX_COLUMNS, Math.ceil(Math.sqrt(count)));
}
