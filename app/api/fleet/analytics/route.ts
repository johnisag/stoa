import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import { getFleetAnalytics } from "@/lib/fleet/analytics";

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const rawLimit = request.nextUrl.searchParams.get("limitRuns");
  const limitRuns = rawLimit == null ? undefined : Number(rawLimit);
  try {
    return NextResponse.json(getFleetAnalytics({ limitRuns }));
  } catch (error) {
    console.error("[fleet] analytics failed:", error);
    return NextResponse.json(
      { error: "Failed to derive fleet analytics" },
      { status: 500 }
    );
  }
}
