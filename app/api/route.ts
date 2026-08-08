import { NextResponse } from "next/server";
import { PUBLIC_API_ENDPOINTS } from "@/lib/api-manifest";

// GET /api — public API discovery manifest.
// Lists all read-only public endpoints for external tools.
export async function GET() {
  return NextResponse.json({
    name: "Stoa REST API",
    version: "1.0.0",
    description:
      "Self-hosted cockpit for AI coding agents. All endpoints except /api/readiness require an auth token (admin or observer scope).",
    auth: {
      type: "token",
      header: "Authorization: Bearer <token>",
      scopes: ["admin", "observer"],
    },
    endpoints: PUBLIC_API_ENDPOINTS,
  });
}
