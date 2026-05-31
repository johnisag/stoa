import { NextResponse } from "next/server";
import { getBackendType } from "@/lib/session-backend";

// GET /api/backend - report the active session backend ("pty" | "tmux").
// The client uses this to decide whether to attach natively (pty) or drive
// tmux via the terminal (legacy).
export async function GET() {
  return NextResponse.json({ backend: getBackendType() });
}
