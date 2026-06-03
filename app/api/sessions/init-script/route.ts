import { NextRequest, NextResponse } from "next/server";
import { writeInitScript } from "@/lib/banner";

// POST /api/sessions/init-script - Create init script and return path.
// The banner/script itself lives in lib/banner.ts (single source of truth) so
// the tmux interactive path and orchestration workers stay byte-identical.
export async function POST(request: NextRequest) {
  try {
    const { agentCommand } = await request.json();

    if (!agentCommand) {
      return NextResponse.json(
        { error: "agentCommand is required" },
        { status: 400 }
      );
    }

    const { scriptPath, command } = writeInitScript(agentCommand);
    return NextResponse.json({ scriptPath, command });
  } catch (error) {
    console.error("Error creating init script:", error);
    return NextResponse.json(
      { error: "Failed to create init script" },
      { status: 500 }
    );
  }
}
