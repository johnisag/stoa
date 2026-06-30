#!/usr/bin/env node
/*
 * Stoa - Claude Code statusline hook (M2b).
 *
 * Claude invokes this once per session (and on refresh) with the statusline JSON on
 * stdin - schema: https://code.claude.com/docs/en/statusline. We do two things:
 *
 *   1. Map the `rate_limits` block -> the Stoa-DEFINED M2a record and write it to
 *      ~/.stoa/rate-limits.json, so the Agent Monitor's quota gauge can read the
 *      PROACTIVE 5h/7d window utilization (lib/rate-limit-window.ts is the reader).
 *   2. Print a concise status line to stdout (Claude renders our stdout as the bar).
 *
 * Claude reports `used_percentage` as 0..100 and `resets_at` as epoch SECONDS; the
 * M2a record uses a 0..1 fraction + epoch MILLIS, so we convert. `rate_limits` only
 * appears for Claude Pro/Max after the first API response, and each window may be
 * independently absent - we map what's present and SKIP the write when nothing usable
 * is there (so a free-tier / pre-first-response session can't clobber a good record).
 *
 * Dependency-free CommonJS so it runs under plain `node` on Windows/macOS/Linux. The
 * pure mapping/formatting is exported + unit-tested; main() is guarded by
 * `require.main === module`, so importing has no side effects. Best-effort and
 * fail-OPEN: it never throws in a way that would break Claude's statusline.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/** A finite number >= 0, else null. */
function nonNegNum(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Normalize one Claude rate-limit window ({ used_percentage: 0..100, resets_at: epoch
 * seconds }) into { pct: 0..1, resetAt: epoch ms | null }, or null when it carries no
 * usable percentage. Pure -> unit-tested.
 */
function windowFrom(entry) {
  if (!entry || typeof entry !== "object") return null;
  const pct = nonNegNum(entry.used_percentage);
  if (pct === null) return null;
  const resetSec = nonNegNum(entry.resets_at);
  return {
    pct: pct / 100,
    resetAt: resetSec === null ? null : resetSec * 1000,
  };
}

/**
 * Map Claude's statusline JSON -> the M2a RateLimitWindowRecord shape
 * ({ fiveHourPct?, sevenDayPct?, resetAt, updatedAt }), or null when there's no usable
 * rate-limit window (free tier, or before the first API response). Returning null tells
 * main() to SKIP the write so an empty session can't overwrite a good record. `resetAt`
 * is the reset of the MORE-CONSTRAINED (higher-utilization) window - the one M2a's
 * windowUtilization treats as binding (pct = max of the known windows). Pure -> tested.
 */
function mapStatuslineToRecord(input, nowMs) {
  const rl = input && typeof input === "object" ? input.rate_limits : null;
  if (!rl || typeof rl !== "object") return null;
  const five = windowFrom(rl.five_hour);
  const seven = windowFrom(rl.seven_day);
  if (!five && !seven) return null;
  const binding =
    five && seven ? (seven.pct >= five.pct ? seven : five) : five || seven;
  const record = { updatedAt: nowMs };
  if (five) record.fiveHourPct = five.pct;
  if (seven) record.sevenDayPct = seven.pct;
  record.resetAt = binding ? binding.resetAt : null;
  return record;
}

/**
 * A concise status line from the same JSON (Claude renders our stdout as the bar),
 * e.g. "Opus * ctx 8% * 5h 24% * 7d 41%". Only includes parts that are present;
 * returns "" when nothing is known. Pure -> unit-tested.
 */
function formatStatusLine(input) {
  if (!input || typeof input !== "object") return "";
  const parts = [];
  const model = input.model;
  if (model && typeof model.display_name === "string" && model.display_name) {
    parts.push(model.display_name);
  }
  const ctx = input.context_window;
  if (ctx && typeof ctx === "object" && Number.isFinite(ctx.used_percentage)) {
    parts.push(`ctx ${Math.round(ctx.used_percentage)}%`);
  }
  const rl = input.rate_limits;
  if (rl && typeof rl === "object") {
    if (rl.five_hour && Number.isFinite(rl.five_hour.used_percentage)) {
      parts.push(`5h ${Math.round(rl.five_hour.used_percentage)}%`);
    }
    if (rl.seven_day && Number.isFinite(rl.seven_day.used_percentage)) {
      parts.push(`7d ${Math.round(rl.seven_day.used_percentage)}%`);
    }
  }
  return parts.join(" · ");
}

/** Where the M2a record lives (the file lib/rate-limit-window.ts reads). */
function recordPath() {
  return path.join(os.homedir(), ".stoa", "rate-limits.json");
}

/** Best-effort write of the record; swallows IO errors so we never break the
 *  statusline (the reader fail-closes on a missing/malformed/stale file anyway). */
function writeRecord(record) {
  try {
    const file = recordPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record), "utf8");
  } catch {
    /* ignore */
  }
}

/** Read all of stdin (fd 0); "" on any error. */
function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  let input = null;
  try {
    input = JSON.parse(readStdin());
  } catch {
    input = null;
  }
  const record = mapStatuslineToRecord(input, Date.now());
  if (record) writeRecord(record);
  process.stdout.write(formatStatusLine(input));
}

if (require.main === module) main();

module.exports = {
  windowFrom,
  mapStatuslineToRecord,
  formatStatusLine,
  recordPath,
};
