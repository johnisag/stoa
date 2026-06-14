import { NextResponse } from "next/server";
import { resolveModelForAgent } from "@/lib/model-catalog";
import { isValidAgentType, type AgentType } from "@/lib/providers";
import { spawnWorker } from "@/lib/orchestration";
import {
  parseJsonBody,
  getAllowedPathRoots,
  resolveSandboxedPath,
} from "@/lib/api-security";

export async function POST(request: Request) {
  const parsed = await parseJsonBody<{
    conductorSessionId?: string;
    task?: string;
    workingDirectory?: string;
    branchName?: string;
    useWorktree?: boolean;
    model?: string;
    agentType?: string;
  }>(request);
  if (!parsed.ok) return parsed.response;

  const body = parsed.data;
  const {
    conductorSessionId,
    task,
    workingDirectory,
    branchName,
    useWorktree = true,
    model,
    agentType: rawAgentType = "claude",
  } = body;
  const agentType: AgentType = isValidAgentType(rawAgentType)
    ? rawAgentType
    : "claude";
  const resolvedModel = resolveModelForAgent(
    agentType,
    typeof model === "string" ? model.trim() : model
  );

  if (!conductorSessionId || !task || !workingDirectory) {
    return NextResponse.json(
      {
        error:
          "Missing required fields: conductorSessionId, task, workingDirectory",
      },
      { status: 400 }
    );
  }

  // workingDirectory must resolve inside a registered project/repo root.
  const roots = getAllowedPathRoots();
  const { allowed, resolved } = resolveSandboxedPath(workingDirectory, roots);
  if (!allowed) {
    return NextResponse.json(
      { error: "workingDirectory is outside the allowed workspace" },
      { status: 403 }
    );
  }

  try {
    const session = await spawnWorker({
      conductorSessionId,
      task,
      workingDirectory: resolved,
      branchName,
      useWorktree,
      model: resolvedModel,
      agentType,
    });

    return NextResponse.json({ session });
  } catch (error) {
    console.error("Failed to spawn worker:", error);
    return NextResponse.json(
      { error: "Failed to spawn worker" },
      { status: 500 }
    );
  }
}
