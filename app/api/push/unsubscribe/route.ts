import { NextRequest, NextResponse } from "next/server";
import { deleteSubscription } from "@/lib/push";

// POST /api/push/unsubscribe — forget a PushSubscription by endpoint.
export async function POST(request: NextRequest) {
  try {
    const { endpoint } = await request.json();
    if (typeof endpoint === "string" && endpoint) deleteSubscription(endpoint);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("push unsubscribe failed:", error);
    return NextResponse.json(
      { error: "Failed to unsubscribe" },
      { status: 500 }
    );
  }
}
