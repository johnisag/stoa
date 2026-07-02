import { NextRequest, NextResponse } from "next/server";
import {
  supportedSubagentProviders,
  materializeRoleSubagent,
  materializeAllRoles,
  MATERIALIZABLE_ROLES,
  SubagentValidationError,
} from "@/lib/subagents";
import { isWorkflowRole } from "@/lib/command/workflow-roles";

// Subagents (#35): materialize Stoa workflow ROLES into a provider's native
// subagent directory (~/.claude/agents/<role>/AGENT.md) as scoped, reusable
// personas (a tools allowlist per role). Sibling of /api/skills (native slash
// commands). Localhost-gated is unnecessary — this writes only to the local
// operator's own ~/.claude tree, same as /api/skills.
//
// GET  /api/subagents                         → providers that support subagents + the roles
// POST /api/subagents { provider }            → install ALL roles (skips existing)
// POST /api/subagents { provider, role }      → install/overwrite one role

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET() {
  return NextResponse.json({
    providers: supportedSubagentProviders(),
    roles: MATERIALIZABLE_ROLES,
  });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  try {
    const { provider, role } = (body ?? {}) as {
      provider?: unknown;
      role?: unknown;
    };
    if (typeof provider !== "string") return badRequest("provider is required");

    // A single named role: an explicit action, so overwrite an existing file.
    if (role != null) {
      if (typeof role !== "string" || !isWorkflowRole(role)) {
        return badRequest("unknown role");
      }
      const r = materializeRoleSubagent(provider, role, { overwrite: true });
      return NextResponse.json({ written: [role], skipped: [], path: r.path });
    }

    // No role → install the whole role library, leaving any hand-authored file alone.
    const result = materializeAllRoles(provider);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof SubagentValidationError)
      return badRequest(error.message);
    console.error("subagents POST failed:", error);
    return NextResponse.json(
      { error: "Failed to install subagents" },
      { status: 500 }
    );
  }
}
