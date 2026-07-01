import { NextRequest, NextResponse } from "next/server";
import { getProject, addProjectStartupCommand } from "@/lib/projects";
import { parseJsonBody, tokenizeCommand } from "@/lib/api-security";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/projects/[id]/startup-commands — add a startup command (#14b).
// The command must tokenize cleanly (no shell metacharacters): it will be run
// safe-exec'd as argv on session boot, never through a shell.
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const project = getProject(id);

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    if (project.is_uncategorized) {
      return NextResponse.json(
        { error: "Cannot add startup commands to Uncategorized project" },
        { status: 400 }
      );
    }

    const parsed = await parseJsonBody<{
      name?: string;
      command?: string;
    }>(request);
    if (!parsed.ok) return parsed.response;

    const { name, command } = parsed.data;

    if (!name || !command) {
      return NextResponse.json(
        { error: "Name and command are required" },
        { status: 400 }
      );
    }

    try {
      tokenizeCommand(command);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid command";
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const startupCommand = addProjectStartupCommand(id, { name, command });

    return NextResponse.json({ startupCommand }, { status: 201 });
  } catch (error) {
    console.error("Error adding startup command:", error);
    return NextResponse.json(
      { error: "Failed to add startup command" },
      { status: 500 }
    );
  }
}
