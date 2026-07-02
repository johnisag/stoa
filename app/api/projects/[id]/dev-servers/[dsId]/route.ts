import { NextRequest, NextResponse } from "next/server";
import { updateProjectDevServer, deleteProjectDevServer } from "@/lib/projects";
import { queries, db, type ProjectDevServer } from "@/lib/db";
import { parseJsonBody, tokenizeCommand } from "@/lib/api-security";

interface RouteParams {
  params: Promise<{ id: string; dsId: string }>;
}

// PATCH /api/projects/[id]/dev-servers/[dsId] - Update a dev server config
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { dsId } = await params;

    const existing = queries.getProjectDevServer(db).get(dsId) as
      ProjectDevServer | undefined;
    if (!existing) {
      return NextResponse.json(
        { error: "Dev server config not found" },
        { status: 404 }
      );
    }

    const parsed = await parseJsonBody<{
      name?: string;
      type?: string;
      command?: string;
      port?: number;
      portEnvVar?: string;
      sortOrder?: number;
    }>(request);
    if (!parsed.ok) return parsed.response;

    const { name, type, command, port, portEnvVar, sortOrder } = parsed.data;

    if (typeof command === "string") {
      try {
        tokenizeCommand(command);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Invalid command";
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }

    if (typeof type === "string" && type !== "node" && type !== "docker") {
      return NextResponse.json(
        { error: "type must be 'node' or 'docker'" },
        { status: 400 }
      );
    }

    const devServer = updateProjectDevServer(dsId, {
      name,
      type: type as "node" | "docker" | undefined,
      command,
      port,
      portEnvVar,
      sortOrder,
    });

    return NextResponse.json({ devServer });
  } catch (error) {
    console.error("Error updating dev server config:", error);
    return NextResponse.json(
      { error: "Failed to update dev server config" },
      { status: 500 }
    );
  }
}

// DELETE /api/projects/[id]/dev-servers/[dsId] - Delete a dev server config
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { dsId } = await params;

    const existing = queries.getProjectDevServer(db).get(dsId) as
      ProjectDevServer | undefined;
    if (!existing) {
      return NextResponse.json(
        { error: "Dev server config not found" },
        { status: 404 }
      );
    }

    deleteProjectDevServer(dsId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting dev server config:", error);
    return NextResponse.json(
      { error: "Failed to delete dev server config" },
      { status: 500 }
    );
  }
}
