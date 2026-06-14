import { NextRequest, NextResponse } from "next/server";
import { getAllServers, startServer } from "@/lib/dev-servers";
import { parseJsonBody, tokenizeCommand } from "@/lib/api-security";

// GET /api/dev-servers - List all servers with live status
export async function GET() {
  try {
    const servers = await getAllServers();
    return NextResponse.json({ servers });
  } catch (error) {
    console.error("Error getting dev servers:", error);
    return NextResponse.json(
      { error: "Failed to get dev servers" },
      { status: 500 }
    );
  }
}

// POST /api/dev-servers - Start a new server
export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody<{
    projectId?: string;
    type?: string;
    name?: string;
    command?: string;
    workingDirectory?: string;
    ports?: number[];
  }>(request);
  if (!parsed.ok) return parsed.response;

  const { projectId, type, name, command, workingDirectory, ports } =
    parsed.data;

  if (!projectId || !type || !name || !command || !workingDirectory) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  if (type !== "node" && type !== "docker") {
    return NextResponse.json(
      { error: "type must be 'node' or 'docker'" },
      { status: 400 }
    );
  }

  try {
    // Reject commands that contain shell metacharacters before passing them to
    // the dev-server layer.
    tokenizeCommand(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid command";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const server = await startServer({
      projectId,
      type,
      name,
      command,
      workingDirectory,
      ports,
    });

    return NextResponse.json({ server });
  } catch (error) {
    console.error("Error starting dev server:", error);
    const message =
      error instanceof Error ? error.message : "Failed to start dev server";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
