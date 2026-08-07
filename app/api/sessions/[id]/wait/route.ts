import { NextRequest, NextResponse } from "next/server";
import {
  waitForSessionStatus,
  type WaitTargetStatus,
} from "@/lib/agent-coordination";
import { parseJsonBody } from "@/lib/api-security";

const VALID_TARGETS = new Set<WaitTargetStatus>([
  "running",
  "waiting",
  "idle",
  "error",
  "dead",
]);

/**
 * POST /api/sessions/[id]/wait — wait for a session to reach a target status.
 *
 * The Stoa equivalent of Herdr's `herdr agent wait <target> --state blocked`.
 * Polls the status detector until the target status is reached or the timeout
 * expires.
 *
 * Body:
 *   { target: "running"|"waiting"|"idle"|"error"|"dead",
 *     timeoutMs?: number,      // default 120000 (2 min)
 *     pollIntervalMs?: number } // default 1000
 *
 * Reply: { status, matched, elapsedMs, lastLine }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const parsed = await parseJsonBody<{
    target: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }>(request);
  if (!parsed.ok) return parsed.response;

  try {
    const { id } = await params;
    const { target, timeoutMs, pollIntervalMs } = parsed.data;

    if (!target || !VALID_TARGETS.has(target as WaitTargetStatus)) {
      return NextResponse.json(
        {
          error: `Invalid target status. Must be one of: ${[...VALID_TARGETS].join(", ")}`,
        },
        { status: 400 }
      );
    }

    // Cap the timeout to prevent resource exhaustion from indefinite waits.
    const cappedTimeout = Math.min(timeoutMs ?? 120_000, 300_000); // max 5 min

    // Floor the poll interval to prevent tight-loop CPU exhaustion. A
    // malicious or careless caller could set pollIntervalMs: 1 and hammer
    // the backend with capture() calls.
    const cappedPoll = Math.max(pollIntervalMs ?? 1000, 250); // min 250ms

    const result = await waitForSessionStatus(id, target as WaitTargetStatus, {
      timeoutMs: cappedTimeout,
      pollIntervalMs: cappedPoll,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }
    return NextResponse.json(result.result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[wait] Error:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
