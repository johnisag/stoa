import { NextRequest, NextResponse } from "next/server";
import { revokeToken } from "@/lib/tokens";
import { requireAdmin } from "@/lib/api-security";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Revoke a token by id (#46/#49). Admin-only; a revoked token fails auth on its
// very next request (resolution requires revoked_at IS NULL). Idempotent.
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const revoked = revokeToken(id);
  return NextResponse.json({ revoked });
}
