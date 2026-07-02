import { NextRequest, NextResponse } from "next/server";
import { materializeAllRoles, SubagentValidationError } from "@/lib/subagents";

// Subagents (#35): one-click install of the Stoa workflow ROLES into a provider's
// native subagent directory (~/.claude/agents/<role>/AGENT.md) as scoped, reusable
// personas (a tools allowlist per role). Sibling of /api/skills (native slash
// commands). Localhost-gating is unnecessary — this writes only to the local
// operator's own home tree, same as /api/skills.
//
// POST /api/subagents { provider } → install every role, leaving any hand-authored
//   file untouched. Returns { written, skipped, dir } so the caller can tell the
//   user which roles landed (and where).

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  try {
    const { provider } = (body ?? {}) as { provider?: unknown };
    if (typeof provider !== "string") return badRequest("provider is required");

    const result = materializeAllRoles(provider);
    // 201 only when something was actually created; all-skipped is a no-op 200.
    return NextResponse.json(result, {
      status: result.written.length > 0 ? 201 : 200,
    });
  } catch (error) {
    if (error instanceof SubagentValidationError)
      return badRequest(error.message);
    console.error("subagents POST failed:", error);
    // Not atomic — a mid-loop failure may have installed some roles; re-running
    // is safe (it only fills in the missing ones).
    return NextResponse.json(
      { error: "Failed to install subagents (re-running is safe)" },
      { status: 500 }
    );
  }
}
