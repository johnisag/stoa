import { NextRequest, NextResponse } from "next/server";
import { db, queries, type Session } from "@/lib/db";
import {
  buildCodexOrchestrationArgs,
  ensureHermesMcpRegistered,
  ensureProviderMcpConfig,
  McpConfigConflictError,
} from "@/lib/mcp-config";
import { expandHome } from "@/lib/platform";
import {
  getProviderDefinition,
  isValidProviderId,
} from "@/lib/providers/registry";

// POST /api/sessions/[id]/mcp-config - Ensure provider-native orchestration
// wiring exists for this session.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = queries.getSession(db).get(id) as Session | undefined;

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const agentType = session.agent_type;
    if (
      !isValidProviderId(agentType) ||
      !getProviderDefinition(agentType).supportsOrchestration
    ) {
      return NextResponse.json(
        {
          error: `Provider ${agentType || "unknown"} does not support orchestration`,
        },
        { status: 400 }
      );
    }

    const workingDirectory = expandHome(session.working_directory);

    if (agentType === "codex") {
      queries
        .updateSessionMcpArgs(db)
        .run(JSON.stringify(buildCodexOrchestrationArgs(id)), id);
    } else if (agentType === "hermes") {
      ensureHermesMcpRegistered();
      queries.updateSessionMcpArgs(db).run("[]", id);
    } else {
      ensureProviderMcpConfig(agentType, workingDirectory, id);
      queries.updateSessionMcpArgs(db).run("[]", id);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof McpConfigConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Failed to write MCP config:", error);
    return NextResponse.json(
      { error: "Failed to write MCP config" },
      { status: 500 }
    );
  }
}
