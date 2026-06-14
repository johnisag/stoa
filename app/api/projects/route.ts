import { NextRequest, NextResponse } from "next/server";
import {
  getAllProjectsWithDevServers,
  createProject,
  validateWorkingDirectory,
  InvalidModelError,
} from "@/lib/projects";
import { parseJsonBody } from "@/lib/api-security";

// GET /api/projects - List all projects with dev server configs
export async function GET() {
  try {
    const projects = getAllProjectsWithDevServers();
    return NextResponse.json({ projects });
  } catch (error) {
    console.error("Error getting projects:", error);
    return NextResponse.json(
      { error: "Failed to get projects" },
      { status: 500 }
    );
  }
}

// POST /api/projects - Create a new project
export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody<{
    name?: string;
    workingDirectory?: string;
    agentType?: string;
    defaultModel?: string;
    devServers?: Array<{
      name: string;
      type: string;
      command: string;
      port?: number;
      portEnvVar?: string;
    }>;
  }>(request);
  if (!parsed.ok) return parsed.response;

  const { name, workingDirectory, agentType, defaultModel, devServers } =
    parsed.data;

  if (!name || !workingDirectory) {
    return NextResponse.json(
      { error: "Name and working directory are required" },
      { status: 400 }
    );
  }

  if (!validateWorkingDirectory(workingDirectory)) {
    return NextResponse.json(
      { error: "Working directory does not exist" },
      { status: 400 }
    );
  }

  try {
    const project = createProject({
      name,
      workingDirectory,
      agentType: agentType as
        | "claude"
        | "codex"
        | "hermes"
        | "kilo"
        | "kimi"
        | "shell"
        | undefined,
      defaultModel,
      devServers: devServers as
        | import("@/lib/projects").CreateDevServerOptions[]
        | undefined,
    });

    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidModelError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Error creating project:", error);
    return NextResponse.json(
      { error: "Failed to create project" },
      { status: 500 }
    );
  }
}
