/**
 * Agent pipelines — in-memory run registry.
 *
 * Holds live + recently-finished pipeline runs so the API can start one and
 * poll its state. Runs are kept in-process only: this is the web-server
 * process, and a run's executor loop lives here too. Persistence across
 * restarts is a tracked follow-up (see docs/ROADMAP.md) — on restart, live
 * runs are lost (their workers keep running as ordinary sessions).
 *
 * Capped (FIFO eviction of terminal runs) so a long-lived server doesn't grow
 * unbounded. The registry is deliberately tiny + dependency-light so it can be
 * unit-tested directly.
 */

import type { PipelineRun } from "./types";
import { isRunComplete } from "./engine";

const MAX_RETAINED_RUNS = 100;

const runs = new Map<string, PipelineRun>();

/** Insert or update a run snapshot. Evicts oldest terminal runs past the cap. */
export function putRun(run: PipelineRun): void {
  runs.set(run.id, run);
  evictIfNeeded();
}

export function getRun(id: string): PipelineRun | undefined {
  return runs.get(id);
}

/** All runs, newest-created first. */
export function listRuns(): PipelineRun[] {
  return Array.from(runs.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export function clearRuns(): void {
  runs.clear();
}

/**
 * Evict oldest runs when over the cap. Prefers evicting COMPLETED runs (oldest
 * first) so live runs survive a burst. But if the map is over a HARD ceiling
 * and there are no terminal runs to drop (e.g. many zombie/never-completing
 * runs), evict the oldest run regardless so the cap is a true bound, never a
 * no-op.
 */
function evictIfNeeded(): void {
  if (runs.size <= MAX_RETAINED_RUNS) return;

  const terminalOldestFirst = Array.from(runs.values())
    .filter((r) => isRunComplete(r))
    .sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt));
  let over = runs.size - MAX_RETAINED_RUNS;
  for (const r of terminalOldestFirst) {
    if (over <= 0) break;
    runs.delete(r.id);
    over--;
  }

  // Hard-ceiling fallback: if zombie (non-terminal) runs still keep us over the
  // ceiling, drop the oldest-created runs outright so memory can't grow forever.
  if (runs.size > MAX_RETAINED_RUNS) {
    const oldestFirst = Array.from(runs.values()).sort(
      (a, b) => a.createdAt - b.createdAt
    );
    let stillOver = runs.size - MAX_RETAINED_RUNS;
    for (const r of oldestFirst) {
      if (stillOver <= 0) break;
      runs.delete(r.id);
      stillOver--;
    }
  }
}
