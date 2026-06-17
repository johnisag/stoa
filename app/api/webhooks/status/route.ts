/**
 * GET /api/webhooks/status
 *
 * Returns whether STOA_WEBHOOK_SECRET is configured.
 * Never exposes the secret value — only a boolean.
 */

import { NextResponse } from "next/server";
import { getWebhookSecret } from "@/lib/webhooks/verify";

export async function GET() {
  const configured = getWebhookSecret() !== null;
  return NextResponse.json({ configured });
}
