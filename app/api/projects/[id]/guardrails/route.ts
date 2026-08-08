import { NextRequest, NextResponse } from "next/server";
import {
  loadCustomRules,
  saveCustomRules,
  RuleValidationError,
} from "@/lib/guardrail-rules";
import { requireAdmin } from "@/lib/api-security";

// GET /api/projects/[id]/guardrails → list custom rules for a project
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const rules = await loadCustomRules(id);
    return NextResponse.json({ rules });
  } catch (error) {
    console.error("guardrails GET failed:", error);
    return NextResponse.json(
      { error: "Failed to load guardrail rules" },
      { status: 500 }
    );
  }
}

// PUT /api/projects/[id]/guardrails { rules: [...] } → replace all custom rules
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }
  try {
    const { id } = await params;
    const { rules } = (body ?? {}) as { rules?: unknown };
    const saved = await saveCustomRules(id, rules);
    return NextResponse.json({ rules: saved });
  } catch (error) {
    if (error instanceof RuleValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("guardrails PUT failed:", error);
    return NextResponse.json(
      { error: "Failed to save guardrail rules" },
      { status: 500 }
    );
  }
}
