import { NextRequest, NextResponse } from "next/server";
import { parseJsonBody, requireLocalhost } from "@/lib/api-security";
import { validateFields } from "@/lib/mcp/elicit-schema";
import { createElicit, listPending } from "@/lib/mcp/elicit-store";

// POST /api/mcp/elicit — the MCP server (same host) registers an agent's request
// for structured operator input. Localhost-gated like every route the MCP tools
// hit. Body: { conductorId, message, fields }.
export async function POST(request: NextRequest) {
  const local = requireLocalhost(request);
  if (!local.ok) return local.response;

  const parsed = await parseJsonBody<{
    conductorId?: string;
    message?: unknown;
    fields?: unknown;
  }>(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { conductorId } = parsed.data;
  if (typeof conductorId !== "string" || !conductorId.trim()) {
    return NextResponse.json(
      { error: "conductorId is required" },
      { status: 400 }
    );
  }

  // Fail-closed schema validation — a hostile/confused agent can't smuggle an
  // over-large or malformed form.
  const valid = validateFields({
    message: parsed.data.message,
    fields: parsed.data.fields,
  });
  if (!valid.ok) {
    return NextResponse.json({ error: valid.error }, { status: 400 });
  }

  const created = createElicit(conductorId, valid.request);
  if (!created.ok) {
    // Per-conductor pending cap exceeded (DoS bound).
    return NextResponse.json({ error: created.error }, { status: 429 });
  }
  return NextResponse.json({ elicitationId: created.id }, { status: 201 });
}

// GET /api/mcp/elicit — the operator-facing queue of pending requests, for the
// inbox UI. NOT localhost-gated (a remote operator via `stoa share` must see it);
// the normal auth gate applies. Never leaks anything but the form to render.
export async function GET() {
  const elicitations = listPending().map((e) => ({
    id: e.id,
    conductorId: e.conductorId,
    message: e.message,
    fields: e.fields,
    createdAt: e.createdAt,
  }));
  return NextResponse.json({ elicitations });
}
