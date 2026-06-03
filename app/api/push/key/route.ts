import { NextResponse } from "next/server";
import { getVapidKeys } from "@/lib/push";

// GET /api/push/key — the VAPID public key the client needs to subscribe.
export async function GET() {
  try {
    return NextResponse.json({ publicKey: getVapidKeys().publicKey });
  } catch (error) {
    console.error("Failed to get VAPID key:", error);
    return NextResponse.json({ error: "Push not available" }, { status: 500 });
  }
}
