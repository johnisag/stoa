import { NextRequest, NextResponse } from "next/server";
import { createToken, listTokens, TokenValidationError } from "@/lib/tokens";
import { requireAdmin } from "@/lib/api-security";

// Per-device named revocable tokens (#46/#49). All handlers are ADMIN-ONLY:
// mutations are already blocked for a read-only observer by the server's coarse
// method gate, and requireAdmin additionally denies an observer the GET list (a
// device roster is not for a spectator). Secrets are returned exactly ONCE, on
// create — the server only ever stores their hash.

export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return NextResponse.json({ tokens: listTokens() });
}

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }
  try {
    const { name, scope } = (body ?? {}) as { name?: unknown; scope?: unknown };
    // Returns { id, token, name, scope } — `token` is the plaintext secret, shown
    // once. The caller builds the share URL (`?token=<token>`).
    const created = createToken(name, scope);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof TokenValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("token create failed:", error);
    return NextResponse.json(
      { error: "Failed to create token" },
      { status: 500 }
    );
  }
}
