import { NextRequest, NextResponse } from "next/server";
import { getServerLogs } from "@/lib/dev-servers";
import { parseBoundedInt } from "@/lib/api-security";

const MAX_LOG_LINES = 10000;

// GET /api/dev-servers/[id]/logs - Get server logs
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const lines = parseBoundedInt(
      searchParams.get("lines"),
      0,
      MAX_LOG_LINES,
      100
    );

    const logs = await getServerLogs(id, lines);
    return NextResponse.json({ logs });
  } catch (error) {
    console.error("Error getting dev server logs:", error);
    return NextResponse.json(
      { error: "Failed to get dev server logs" },
      { status: 500 }
    );
  }
}
