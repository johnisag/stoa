import { NextRequest, NextResponse } from "next/server";
import {
  updateProjectStartupCommand,
  deleteProjectStartupCommand,
} from "@/lib/projects";
import { queries, db, type ProjectStartupCommand } from "@/lib/db";
import { parseJsonBody, tokenizeCommand } from "@/lib/api-security";

interface RouteParams {
  params: Promise<{ id: string; cmdId: string }>;
}

// PATCH /api/projects/[id]/startup-commands/[cmdId] — update a startup command.
// An updated command re-validates through tokenizeCommand (same gate as create).
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id, cmdId } = await params;

    const existing = queries.getProjectStartupCommand(db).get(cmdId) as
      ProjectStartupCommand | undefined;
    // Ownership check: the command must belong to the project in the URL, so a
    // valid cmdId from ANOTHER project can't be edited through this path.
    if (!existing || existing.project_id !== id) {
      return NextResponse.json(
        { error: "Startup command not found" },
        { status: 404 }
      );
    }

    const parsed = await parseJsonBody<{
      name?: string;
      command?: string;
      sortOrder?: number;
    }>(request);
    if (!parsed.ok) return parsed.response;

    const { name, command, sortOrder } = parsed.data;

    if (typeof command === "string") {
      try {
        tokenizeCommand(command);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Invalid command";
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }

    const startupCommand = updateProjectStartupCommand(cmdId, {
      name,
      command,
      sortOrder,
    });

    return NextResponse.json({ startupCommand });
  } catch (error) {
    console.error("Error updating startup command:", error);
    return NextResponse.json(
      { error: "Failed to update startup command" },
      { status: 500 }
    );
  }
}

// DELETE /api/projects/[id]/startup-commands/[cmdId] — delete a startup command
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id, cmdId } = await params;

    const existing = queries.getProjectStartupCommand(db).get(cmdId) as
      ProjectStartupCommand | undefined;
    // Same ownership check as PATCH — a foreign cmdId reads as not-found.
    if (!existing || existing.project_id !== id) {
      return NextResponse.json(
        { error: "Startup command not found" },
        { status: 404 }
      );
    }

    deleteProjectStartupCommand(cmdId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting startup command:", error);
    return NextResponse.json(
      { error: "Failed to delete startup command" },
      { status: 500 }
    );
  }
}
