import { describe, expect, it } from "vitest";
import {
  FLEET_STATUS_CAPTURE_HARD_MAX_PER_TICK,
  FLEET_STATUS_MAX_CAPTURE_INTERVAL_MS,
  FLEET_STATUS_MIN_CAPTURE_INTERVAL_MS,
  FLEET_STATUS_SUMMARY_MAX_CHARS,
  decideFleetStatusObservation,
  fleetStatusCaptureDelayMs,
  selectDueFleetStatusWorkers,
  summarizeFleetRenderedStatus,
  type FleetStatusWorkerCandidate,
} from "@/lib/fleet/status-aggregation";

const NOW = new Date("2026-08-01T12:00:00.000Z");

function candidate(
  index: number,
  overrides: Partial<FleetStatusWorkerCandidate> = {}
): FleetStatusWorkerCandidate {
  return {
    runId: `run-${index % 4}`,
    workerId: `worker-${String(index).padStart(2, "0")}`,
    sessionId: `session-${index}`,
    attempt: 1,
    workerStatus: "running",
    lastCapturedAt: new Date(
      NOW.getTime() - (60 - index) * 1_000
    ).toISOString(),
    nextCaptureAt: new Date(NOW.getTime() - 1_000).toISOString(),
    ...overrides,
  };
}

describe("Fleet global rendered-status selection", () => {
  it("selects at most the global hard cap across 40 workers", () => {
    const workers = Array.from({ length: 40 }, (_, index) => candidate(index));

    const selected = selectDueFleetStatusWorkers(workers, {
      now: NOW,
      maxCaptures: 10_000,
    });

    expect(selected).toHaveLength(FLEET_STATUS_CAPTURE_HARD_MAX_PER_TICK);
    expect(selected.map((worker) => worker.workerId)).toEqual(
      Array.from(
        { length: FLEET_STATUS_CAPTURE_HARD_MAX_PER_TICK },
        (_, index) => `worker-${String(index).padStart(2, "0")}`
      )
    );
    expect(new Set(selected.map((worker) => worker.runId)).size).toBe(4);
  });

  it("is deterministic regardless of query order and rotates by oldest due", () => {
    const workers = Array.from({ length: 8 }, (_, index) => candidate(index));
    const forward = selectDueFleetStatusWorkers(workers, {
      now: NOW,
      maxCaptures: 3,
    });
    const reversed = selectDueFleetStatusWorkers([...workers].reverse(), {
      now: NOW,
      maxCaptures: 3,
    });

    expect(reversed.map((worker) => worker.workerId)).toEqual(
      forward.map((worker) => worker.workerId)
    );
    expect(forward.map((worker) => worker.workerId)).toEqual([
      "worker-00",
      "worker-01",
      "worker-02",
    ]);
  });

  it("never recaptures before the per-worker minimum interval", () => {
    const tooRecent = candidate(1, {
      lastCapturedAt: new Date(
        NOW.getTime() - FLEET_STATUS_MIN_CAPTURE_INTERVAL_MS + 1
      ).toISOString(),
      nextCaptureAt: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    const exactlyDue = candidate(2, {
      lastCapturedAt: new Date(
        NOW.getTime() - FLEET_STATUS_MIN_CAPTURE_INTERVAL_MS
      ).toISOString(),
      nextCaptureAt: new Date(NOW.getTime() - 60_000).toISOString(),
    });

    expect(
      selectDueFleetStatusWorkers([tooRecent, exactlyDue], { now: NOW }).map(
        (worker) => worker.workerId
      )
    ).toEqual([exactlyDue.workerId]);
  });

  it("fails closed on malformed, inactive, or duplicate durable rows", () => {
    const duplicate = candidate(1);
    const malformed = candidate(2, { lastCapturedAt: "yesterday" });
    const inactive = candidate(3, { workerStatus: "completed" });
    const badAttempt = candidate(4, { attempt: 0 });

    expect(
      selectDueFleetStatusWorkers(
        [
          duplicate,
          { ...duplicate, attempt: 0 },
          malformed,
          inactive,
          badAttempt,
        ],
        { now: NOW }
      )
    ).toEqual([]);
    expect(
      selectDueFleetStatusWorkers([candidate(5)], {
        now: new Date(Number.NaN),
      })
    ).toEqual([]);
  });
});

describe("Fleet rendered-status aggregation", () => {
  it("uses adaptive delay with a hard ceiling and fails malformed counters closed", () => {
    expect(fleetStatusCaptureDelayMs("running", 0)).toBe(
      FLEET_STATUS_MIN_CAPTURE_INTERVAL_MS
    );
    expect(fleetStatusCaptureDelayMs("running", 3)).toBe(16_000);
    expect(fleetStatusCaptureDelayMs("dead", 16)).toBe(
      FLEET_STATUS_MAX_CAPTURE_INTERVAL_MS
    );
    expect(fleetStatusCaptureDelayMs("running", -1)).toBe(
      FLEET_STATUS_MAX_CAPTURE_INTERVAL_MS
    );
    expect(fleetStatusCaptureDelayMs("invented", 0)).toBe(
      FLEET_STATUS_MAX_CAPTURE_INTERVAL_MS
    );
  });

  it("produces a bounded one-line summary without terminal controls or secrets", () => {
    const token = `sk-${"a".repeat(32)}`;
    const rendered = [
      "old line",
      `\u001b[31mAPI_KEY=super-secret-value\u001b[0m`,
      `latest ${token.slice(0, 12)}\u0000${token.slice(12)} ${"x".repeat(400)}`,
    ].join("\r\n");

    const result = summarizeFleetRenderedStatus(rendered);

    expect(result.summary).toContain("[REDACTED]");
    expect(result.summary).not.toContain("super-secret-value");
    expect(result.summary).not.toContain(token);
    expect(result.summary).not.toMatch(/[\u0000\u001b\r\n]/);
    expect(result.summary.length).toBeLessThanOrEqual(
      FLEET_STATUS_SUMMARY_MAX_CHARS
    );
    expect(result).toMatchObject({ redacted: true, truncated: true });
  });

  it("omits an oversized rendered input instead of sampling possible secret material", () => {
    const result = summarizeFleetRenderedStatus(
      `unclassified-secret-${"z".repeat(40_000)}`
    );

    expect(result).toEqual({
      summary: "[rendered summary omitted: input exceeded limit]",
      redacted: true,
      replacementCount: 0,
      truncated: true,
    });
  });

  it("coalesces equivalent active states and repeated summaries", () => {
    const active = decideFleetStatusObservation({
      previousStatus: "running",
      previousStableCount: 2,
      observedStatus: "idle",
      rendered: "ready",
      observedAt: NOW,
    });
    const repeated = decideFleetStatusObservation({
      previousStatus: "waiting",
      previousStableCount: 3,
      observedStatus: "waiting",
      rendered: "API_KEY=do-not-persist-this",
      observedAt: NOW,
    });

    expect(active).toMatchObject({
      accepted: true,
      statusClass: "active",
      transition: null,
      coalesced: true,
      stableCount: 0,
    });
    expect(repeated).toMatchObject({
      accepted: true,
      statusClass: "waiting_for_operator",
      transition: null,
      coalesced: true,
      stableCount: 4,
      summary: { redacted: true },
    });
  });

  it("emits one redacted transition only for a meaningful status change", () => {
    const result = decideFleetStatusObservation({
      previousStatus: "running",
      previousStableCount: 8,
      observedStatus: "waiting",
      rendered: "password=correct-horse-battery-staple",
      observedAt: NOW,
    });

    expect(result).toMatchObject({
      accepted: true,
      stableCount: 0,
      transition: {
        eventType: "worker_rendered_status_changed",
        from: "active",
        to: "waiting_for_operator",
        summary: "password=[REDACTED]",
      },
      coalesced: false,
    });
  });

  it("rejects malformed observations and applies the maximum retry delay", () => {
    expect(
      decideFleetStatusObservation({
        previousStatus: "running",
        previousStableCount: Number.POSITIVE_INFINITY,
        observedStatus: "running",
        rendered: "working",
        observedAt: NOW,
      })
    ).toEqual({
      accepted: false,
      reason: "rendered status or stability counter is invalid",
      nextDelayMs: FLEET_STATUS_MAX_CAPTURE_INTERVAL_MS,
      transition: null,
    });
  });
});
