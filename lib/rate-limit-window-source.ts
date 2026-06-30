/**
 * The single I/O point for the M2a rate-limit-window file (~/.stoa/rate-limits.json,
 * written by the M2b statusline hook). Kept SEPARATE from the pure model in
 * lib/rate-limit-window.ts on purpose: that module is client-safe (the Agent Monitor
 * view and its hooks reference its types/pure helpers), and pulling `fs` / `lib/platform`
 * into it would leak node builtins into the browser bundle (AGENTS.md). This module is
 * SERVER-ONLY — import it only from routes / server-side ticks.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { homeDir } from "./platform";
import {
  parseWindowRecord,
  windowUtilization,
  isWindowStale,
  type RateLimitWindow,
  type RateLimitWindowRecord,
} from "./rate-limit-window";

/**
 * Read the proactive Claude rate-limit WINDOW utilization best-effort. Fail-CLOSED: a
 * missing / unreadable / malformed / stale file → null (no signal), never a confident
 * wrong number. Global (per Claude account), not per session.
 */
export function readRateLimitWindow(
  nowMs: number = Date.now()
): RateLimitWindow | null {
  try {
    const raw = readFileSync(
      join(homeDir(), ".stoa", "rate-limits.json"),
      "utf-8"
    );
    return windowUtilization(parseWindowRecord(raw), nowMs);
  } catch {
    return null;
  }
}

/**
 * Read the RAW M2a record (the 5h + 7d breakdown + reset), staleness-validated: null when
 * the file is missing / malformed OR older than the freshness horizon. The telemetry
 * snapshot export (M5) wants BOTH windows, not just the derived binding pct that
 * readRateLimitWindow exposes.
 */
export function readRateLimitWindowRecord(
  nowMs: number = Date.now()
): RateLimitWindowRecord | null {
  try {
    const raw = readFileSync(
      join(homeDir(), ".stoa", "rate-limits.json"),
      "utf-8"
    );
    const record = parseWindowRecord(raw);
    return record && !isWindowStale(record, nowMs) ? record : null;
  } catch {
    return null;
  }
}
