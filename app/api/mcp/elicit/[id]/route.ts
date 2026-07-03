import { NextRequest, NextResponse } from "next/server";
import { requireLocalhost } from "@/lib/api-security";
import { getElicit } from "@/lib/mcp/elicit-store";

// GET /api/mcp/elicit/[id] — the MCP tool polls its pending request's status
// while it blocks. Localhost-gated (the poller is the same-host MCP process).
// Returns the status and, once answered, the operator's action + typed content.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const local = requireLocalhost(request);
  if (!local.ok) return local.response;

  const { id } = await params;
  const e = getElicit(id);
  if (!e) {
    // Unknown or swept — the tool treats a 404 as `cancel` (never a hard error).
    return NextResponse.json({ status: "unknown" }, { status: 404 });
  }
  return NextResponse.json({
    status: e.status,
    action: e.answer?.action ?? null,
    content: e.answer?.content ?? null,
  });
}
