import { NextRequest, NextResponse } from "next/server";
import { readSession } from "@/lib/agent-coordination";
import { parseJsonBody } from "@/lib/api-security";

/**
 * POST /api/sessions/[id]/read — read a session's rendered screen content.
 *
 * The Stoa equivalent of Herdr's `herdr agent read <pane>`. Returns the
 * captured screen text and current status, WITHOUT sending any input.
 *
 * Body (optional):
 *   { maxLines?: number }  — limit to the last N lines (default: all)
 *
 * Reply: { content, lastLine, status }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const parsed = await parseJsonBody<{ maxLines?: number }>(request);
  if (!parsed.ok) return parsed.response;

  try {
    const { id } = await params;
    const result = await readSession(id, parsed.data.maxLines);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }
    return NextResponse.json({
      content: result.content,
      lastLine: result.lastLine,
      status: result.status,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[read] Error:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
