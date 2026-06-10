import { NextResponse } from "next/server";
import { listInboxItems } from "@/lib/verdict-inbox";

/** GET /api/verdict-inbox — the fleet-wide review queue (dispatch PRs + session
 * ceremonies). Cheap (DB-only); the per-lens findings load on demand per item. */
export async function GET() {
  return NextResponse.json({ items: listInboxItems() });
}
