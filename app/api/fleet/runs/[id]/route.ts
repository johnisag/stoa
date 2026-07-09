import { NextResponse } from "next/server";
import { getFleetRunDetail } from "@/lib/fleet/service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const detail = getFleetRunDetail(id);
    if (!detail) {
      return NextResponse.json(
        { error: "Fleet run not found" },
        { status: 404 }
      );
    }
    return NextResponse.json(detail);
  } catch (error) {
    console.error("[fleet] GET /api/fleet/runs/[id] failed:", error);
    return NextResponse.json(
      { error: "Failed to load fleet run" },
      { status: 500 }
    );
  }
}
