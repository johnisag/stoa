import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { backendKeyForSession } from "@/lib/providers/registry";
import { getSessionBackend } from "@/lib/session-backend";
import {
  checkGuardrails,
  deduplicateViolations,
  DEFAULT_RULES,
  type GuardrailViolation,
} from "@/lib/guardrails";
import { parseJsonBody } from "@/lib/api-security";
import {
  assertGenericSessionRouteAccess,
  genericSessionRouteFailure,
} from "@/lib/session-route-access";

/**
 * Per-session guardrail report cache + deduplication state.
 * Lives for the process lifetime — cleared on session death.
 */
const guardrailReported = new Map<string, Map<string, number>>();

const COOLDOWN_MS = 30_000;

/**
 * POST /api/sessions/[id]/guardrails — check a session's rendered screen
 * for guardrail violations.
 *
 * Returns any violations found (deduplicated by cooldown). A "block"
 * severity violation indicates the caller should consider interrupting
 * the session.
 *
 * Reply: { violations: GuardrailViolation[] }
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const session = queries.getSession(db).get(id) as Session | undefined;

    const denied = genericSessionRouteFailure(session);
    if (denied) {
      return NextResponse.json(
        { error: denied.error },
        { status: denied.status }
      );
    }
    assertGenericSessionRouteAccess(session);

    const key = backendKeyForSession(session);
    const backend = getSessionBackend();

    if (!(await backend.exists(key))) {
      return NextResponse.json(
        { error: "Session is not running" },
        { status: 400 }
      );
    }

    // Capture the screen and check against guardrail rules.
    const content = await backend.capture(key);
    const rawViolations = checkGuardrails(content, DEFAULT_RULES, key);

    // Deduplicate: suppress same rule+session within cooldown.
    let reported = guardrailReported.get(id);
    if (!reported) {
      reported = new Map();
      guardrailReported.set(id, reported);
    }
    const violations: GuardrailViolation[] = deduplicateViolations(
      rawViolations,
      reported,
      COOLDOWN_MS
    );

    return NextResponse.json({ violations });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[guardrails] Error:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
