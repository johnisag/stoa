import type Database from "better-sqlite3";
import { getDb, queries, type Session } from "@/lib/db";
import { backendKeyForSession } from "@/lib/providers/registry";
import { getSessionBackend, type SessionBackend } from "@/lib/session-backend";
import { chargeFleetRuntimeUsage } from "./resource-runtime";
import type { FleetWorkerRow } from "./types";
import type { FleetWorkerOutputDto } from "./worker-output-types";

export type { FleetWorkerOutputDto } from "./worker-output-types";

export const FLEET_WORKER_OUTPUT_DEFAULT_LINES = 80;
export const FLEET_WORKER_OUTPUT_MAX_LINES = 200;
export const FLEET_WORKER_OUTPUT_MAX_CHARS = 64 * 1024;
export const FLEET_WORKER_OUTPUT_ID_MAX = 160;

const ACTIVE_OUTPUT_STATES = new Set(["running", "waiting_for_operator"]);

export interface FleetWorkerOutputRequest {
  runId: string;
  workerId: string;
  expectedAttempt: number;
  expectedSessionId: string;
  lines?: number;
}

export type FleetWorkerOutputResult =
  | { ok: true; output: FleetWorkerOutputDto }
  | {
      ok: false;
      status: 400 | 404 | 409 | 429 | 502;
      error: string;
      retryAt?: string | null;
    };

interface FleetWorkerOutputDeps {
  db?: Database.Database;
  backend?: Pick<SessionBackend, "exists" | "capture">;
  now?: () => Date;
  chargeUsage?: typeof chargeFleetRuntimeUsage;
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= FLEET_WORKER_OUTPUT_ID_MAX;
}

function normalizeRenderedOutput(
  rendered: string,
  requestedLines: number
): { output: string; lines: number; truncated: boolean } {
  const clean = rendered
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const allLines = clean.split("\n");
  const selected = allLines.slice(-requestedLines).join("\n");
  const lineTruncated = allLines.length > requestedLines;
  const charTruncated = selected.length > FLEET_WORKER_OUTPUT_MAX_CHARS;
  const output = charTruncated
    ? selected.slice(-FLEET_WORKER_OUTPUT_MAX_CHARS)
    : selected;
  return {
    output,
    lines: output.length === 0 ? 0 : output.split("\n").length,
    truncated: lineTruncated || charTruncated,
  };
}

function sameActiveAttempt(
  worker: FleetWorkerRow | undefined,
  request: FleetWorkerOutputRequest
): worker is FleetWorkerRow {
  return !!(
    worker &&
    worker.attempt === request.expectedAttempt &&
    worker.session_id === request.expectedSessionId &&
    ACTIVE_OUTPUT_STATES.has(worker.status)
  );
}

/**
 * Capture one worker's rendered screen through SessionBackend. The Fleet row is
 * checked both before and after capture so a recycled/retried worker session can
 * never be returned under stale UI preconditions.
 */
export async function captureFleetWorkerOutput(
  request: FleetWorkerOutputRequest,
  deps: FleetWorkerOutputDeps = {}
): Promise<FleetWorkerOutputResult> {
  if (
    !validId(request.runId) ||
    !validId(request.workerId) ||
    !validId(request.expectedSessionId) ||
    !Number.isSafeInteger(request.expectedAttempt) ||
    request.expectedAttempt < 1
  ) {
    return { ok: false, status: 400, error: "invalid worker output binding" };
  }
  const lines = request.lines ?? FLEET_WORKER_OUTPUT_DEFAULT_LINES;
  if (
    !Number.isSafeInteger(lines) ||
    lines < 1 ||
    lines > FLEET_WORKER_OUTPUT_MAX_LINES
  ) {
    return { ok: false, status: 400, error: "lines must be between 1 and 200" };
  }

  const db = deps.db ?? getDb();
  const getWorker = db.prepare(
    `SELECT * FROM fleet_workers WHERE fleet_run_id = ? AND id = ?`
  );
  const worker = getWorker.get(request.runId, request.workerId) as
    FleetWorkerRow | undefined;
  if (!worker) {
    return { ok: false, status: 404, error: "Fleet worker not found" };
  }
  if (!sameActiveAttempt(worker, request)) {
    return {
      ok: false,
      status: 409,
      error: "Fleet worker attempt or active session changed; refresh first",
    };
  }

  const session = queries.getSession(db).get(worker.session_id!) as
    Session | undefined;
  if (!session || session.id !== request.expectedSessionId) {
    return {
      ok: false,
      status: 409,
      error: "Persisted Fleet worker session is unavailable",
    };
  }

  const backend = deps.backend ?? getSessionBackend();
  const backendKey = backendKeyForSession(session);
  try {
    if (!(await backend.exists(backendKey))) {
      return {
        ok: false,
        status: 409,
        error: "Fleet worker terminal is no longer active",
      };
    }
    const rendered = await backend.capture(backendKey, { lines });

    const current = getWorker.get(request.runId, request.workerId) as
      FleetWorkerRow | undefined;
    if (!sameActiveAttempt(current, request)) {
      return {
        ok: false,
        status: 409,
        error: "Fleet worker changed while output was captured; refresh first",
      };
    }

    const normalized = normalizeRenderedOutput(rendered, lines);
    const capturedAt = (deps.now ?? (() => new Date()))();
    const outputBytes = Buffer.byteLength(normalized.output, "utf8");
    if (outputBytes > 0) {
      const charged = (deps.chargeUsage ?? chargeFleetRuntimeUsage)(db, {
        runId: request.runId,
        kind: "output_bytes_per_minute",
        units: outputBytes,
        now: capturedAt,
      });
      if (!charged.admitted) {
        return {
          ok: false,
          status: 429,
          error: "Fleet rendered output quota exceeded",
          retryAt: charged.retryAt,
        };
      }
    }
    return {
      ok: true,
      output: {
        runId: request.runId,
        workerId: request.workerId,
        attempt: request.expectedAttempt,
        sessionId: request.expectedSessionId,
        lines: normalized.lines,
        output: normalized.output,
        truncated: normalized.truncated,
        capturedAt: capturedAt.toISOString(),
      },
    };
  } catch {
    return {
      ok: false,
      status: 502,
      error: "Failed to capture rendered Fleet worker output",
    };
  }
}
