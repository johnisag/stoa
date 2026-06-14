import { NextRequest, NextResponse } from "next/server";
import { detectDevServers, validateWorkingDirectory } from "@/lib/projects";
import { parseJsonBody } from "@/lib/api-security";

// POST /api/projects/detect - Detect available dev servers in a directory
export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody<{ workingDirectory?: string }>(request);
  if (!parsed.ok) return parsed.response;

  const { workingDirectory } = parsed.data;

  if (!workingDirectory) {
    return NextResponse.json(
      { error: "Working directory is required" },
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
    const detected = await detectDevServers(workingDirectory);
    return NextResponse.json({ detected });
  } catch (error) {
    console.error("Error detecting dev servers:", error);
    return NextResponse.json(
      { error: "Failed to detect dev servers" },
      { status: 500 }
    );
  }
}
