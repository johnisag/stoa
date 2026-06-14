import { NextRequest, NextResponse } from "next/server";
import { writeInitScript, validateAgentCommand } from "@/lib/banner";
import { parseJsonBody } from "@/lib/api-security";

// POST /api/sessions/init-script - Create init script and return path.
// The banner/script itself lives in lib/banner.ts (single source of truth) so
// the tmux interactive path and orchestration workers stay byte-identical.
export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody<{ agentCommand?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const { agentCommand } = parsed.data;
  const validCommand = validateAgentCommand(agentCommand);

  if (!validCommand) {
    return NextResponse.json(
      { error: "agentCommand is required and must be a safe command string" },
      { status: 400 }
    );
  }

  try {
    const { scriptPath, command } = writeInitScript(validCommand);
    return NextResponse.json({ scriptPath, command });
  } catch (error) {
    console.error("Error creating init script:", error);
    return NextResponse.json(
      { error: "Failed to create init script" },
      { status: 500 }
    );
  }
}
