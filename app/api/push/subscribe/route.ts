import { NextRequest, NextResponse } from "next/server";
import { saveSubscription } from "@/lib/push";

// POST /api/push/subscribe — store a PushSubscription (endpoint + keys).
export async function POST(request: NextRequest) {
  try {
    const sub = await request.json();
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return NextResponse.json(
        { error: "Invalid subscription" },
        { status: 400 }
      );
    }
    saveSubscription({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("push subscribe failed:", error);
    return NextResponse.json({ error: "Failed to subscribe" }, { status: 500 });
  }
}
