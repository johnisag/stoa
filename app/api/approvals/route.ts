import { NextResponse } from "next/server";
import { getApprovalQueue } from "@/lib/approval-queue";

// GET /api/approvals — unified approval queue (Fleet tasks needing attention)
export async function GET() {
  try {
    const items = getApprovalQueue();
    return NextResponse.json({ items, count: items.length });
  } catch (error) {
    console.error("approvals GET failed:", error);
    return NextResponse.json(
      { error: "Failed to load approval queue" },
      { status: 500 }
    );
  }
}
