import { NextRequest, NextResponse } from "next/server";
import { requestScope } from "@/lib/api-security";

// #46/#49 The caller's auth scope, so the client can show a read-only banner and
// hide admin-only affordances for a spectator (the server still enforces every
// boundary — this is purely to explain WHY a mutation would be refused). A GET, so
// an observer can read it.
export async function GET(request: NextRequest) {
  return NextResponse.json({ scope: requestScope(request) });
}
