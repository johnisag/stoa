/**
 * Rate-limit WINDOW utilization (M2a, abtop-inspired) — the PROACTIVE quota signal
 * that complements lib/rate-limit.ts's REACTIVE "limit reached" screen-scrape.
 * Claude meters usage over rolling windows (a 5-hour and a 7-day quota); knowing
 * you're at 85% of the 5h window BEFORE you hit it lets the fleet back off instead
 * of stalling.
 *
 * Claude exposes no official API for this. Per the 2026-06-30 decision, Stoa
 * installs its OWN Claude statusline hook (M2b) that writes a Stoa-DEFINED record
 * (the shape below) to ~/.stoa/rate-limits.json; THIS module is the pure model +
 * fail-closed reader over that file. Everything here is pure/unit-tested and fails
 * CLOSED (null) when the data is missing, malformed, or stale — a wrong "you're
 * fine" or "you're maxed" would mislead the operator and misfire the backoff.
 */

import type { ContextTone } from "./context-window";

/** Amber once a window is this full; red at the next threshold (mirrors the
 *  context-window gauge bands so the two read consistently). */
const WARN_AT = 0.7;
const FULL_AT = 0.9;

/** Reject window data older than this — a stale file (the hook stopped running, or
 *  Claude isn't active) must read as "unknown", never as a confident number. */
export const WINDOW_STALE_MS = 10 * 60_000;

/**
 * The record the statusline hook (M2b) writes per session (or "global"). All
 * percentages are fractions 0..1. Stoa-defined, so it never depends on Claude's
 * (unofficial, shifting) statusline JSON shape — the hook maps onto THIS.
 */
export interface RateLimitWindowRecord {
  /** 5-hour rolling-window utilization, 0..1. */
  fiveHourPct?: number;
  /** 7-day rolling-window utilization, 0..1. */
  sevenDayPct?: number;
  /** epoch-ms the most-constrained window resets (null/absent if unknown). */
  resetAt?: number | null;
  /** epoch-ms the hook last wrote this record — drives staleness. */
  updatedAt: number;
}

/** Window gauge tint band. Reuses the context-gauge vocabulary
 *  ({@link ContextTone}: ok/warn/full) so the two gauges share ONE tone type —
 *  the Monitor's tone→color map can't silently drift between them. */
export type WindowTone = ContextTone;

/** The derived, glanceable window state for the UI + backoff. */
export interface RateLimitWindow {
  /** The BINDING constraint: the max of the known window fractions, clamped 0..1. */
  pct: number;
  resetAt: number | null;
  tone: WindowTone;
}

/** Is this record too old to trust? Pure. */
export function isWindowStale(
  record: RateLimitWindowRecord,
  nowMs: number
): boolean {
  return (
    !Number.isFinite(record.updatedAt) ||
    nowMs - record.updatedAt > WINDOW_STALE_MS
  );
}

/**
 * Derive the binding window utilization from a record, or null when it can't be
 * trusted (stale, or no usable percentage). The binding constraint is the MAX of
 * the known windows — whichever quota you'll hit first. Pure → unit-tested.
 */
export function windowUtilization(
  record: RateLimitWindowRecord | null | undefined,
  nowMs: number
): RateLimitWindow | null {
  if (!record || isWindowStale(record, nowMs)) return null;
  const known = [record.fiveHourPct, record.sevenDayPct].filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0
  );
  if (known.length === 0) return null;
  const pct = Math.min(1, Math.max(...known));
  const tone: WindowTone =
    pct >= FULL_AT ? "full" : pct >= WARN_AT ? "warn" : "ok";
  return {
    pct,
    resetAt:
      typeof record.resetAt === "number" && Number.isFinite(record.resetAt)
        ? record.resetAt
        : null,
    tone,
  };
}

/**
 * Parse the on-disk file body into a record, or null if unusable. Fail-closed:
 * a malformed JSON, a non-object, or a missing/invalid `updatedAt` all yield null
 * (treated as "no data" by windowUtilization). Pure → unit-tested.
 */
export function parseWindowRecord(
  json: string | null | undefined
): RateLimitWindowRecord | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<RateLimitWindowRecord>;
    if (!v || typeof v !== "object") return null;
    if (typeof v.updatedAt !== "number" || !Number.isFinite(v.updatedAt)) {
      return null;
    }
    return {
      fiveHourPct: numOrUndef(v.fiveHourPct),
      sevenDayPct: numOrUndef(v.sevenDayPct),
      resetAt: typeof v.resetAt === "number" ? v.resetAt : null,
      updatedAt: v.updatedAt,
    };
  } catch {
    return null;
  }
}

function numOrUndef(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}
