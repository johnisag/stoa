import { NextRequest, NextResponse } from "next/server";
import { parseJsonBody } from "@/lib/api-security";
import { coerceAnswer } from "@/lib/mcp/elicit-schema";
import {
  getElicit,
  answerElicit,
  type ElicitAction,
} from "@/lib/mcp/elicit-store";

const ACTIONS: ReadonlySet<string> = new Set(["accept", "decline", "cancel"]);

// POST /api/mcp/elicit/[id]/answer — the operator answers a pending request from
// the inbox. Operator-facing (NOT localhost-gated, so a remote `stoa share`
// admin can answer); this is a WRITE, so server.ts's observer gate already blocks
// read-only tokens. Body: { action: 'accept'|'decline'|'cancel', values? }.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const parsed = await parseJsonBody<{ action?: string; values?: unknown }>(
    request
  );
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = parsed.data.action;
  if (typeof action !== "string" || !ACTIONS.has(action)) {
    return NextResponse.json(
      { error: "action must be accept, decline, or cancel" },
      { status: 400 }
    );
  }

  // Must still be pending — a stale/expired/already-answered id is rejected
  // (the TOCTOU guard: a late reply must not overwrite a settled request).
  const e = getElicit(id);
  if (!e || e.status !== "pending") {
    return NextResponse.json(
      { error: "This request is no longer awaiting an answer" },
      { status: 409 }
    );
  }

  if (action === "accept") {
    // Re-clamp the submitted values server-side against the stored fields — the
    // browser form is never trusted.
    const coerced = coerceAnswer(e.fields, parsed.data.values);
    if (!coerced.ok) {
      return NextResponse.json({ error: coerced.error }, { status: 400 });
    }
    const res = answerElicit(id, {
      action: "accept",
      content: coerced.content,
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: "This request is no longer awaiting an answer" },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: true });
  }

  // decline / cancel — no values.
  const res = answerElicit(id, { action: action as ElicitAction });
  if (!res.ok) {
    return NextResponse.json(
      { error: "This request is no longer awaiting an answer" },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
