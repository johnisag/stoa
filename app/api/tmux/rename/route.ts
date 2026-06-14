import { NextRequest, NextResponse } from "next/server";
import { getSessionBackend } from "@/lib/session-backend";
import { getManagedSessionPattern } from "@/lib/providers/registry";
import { parseJsonBody, requireLocalhost } from "@/lib/api-security";

// POST /api/tmux/rename - Rename a tmux session
export async function POST(request: NextRequest) {
  const auth = requireLocalhost(request);
  if (!auth.ok) return auth.response;

  const parsed = await parseJsonBody<{ oldName?: string; newName?: string }>(
    request
  );
  if (!parsed.ok) return parsed.response;

  const { oldName, newName } = parsed.data;

  if (!oldName || !newName) {
    return NextResponse.json(
      { error: "oldName and newName are required" },
      { status: 400 }
    );
  }

  const managedPattern = getManagedSessionPattern();
  if (!managedPattern.test(oldName) || !managedPattern.test(newName)) {
    return NextResponse.json(
      { error: "Only Stoa-managed session names can be renamed" },
      { status: 400 }
    );
  }

  try {
    // Rename the tmux session
    const backend = getSessionBackend();
    await backend.rename(oldName, newName);

    return NextResponse.json({ success: true, newName });
  } catch (error) {
    console.error("Error renaming tmux session:", error);
    return NextResponse.json(
      { error: "Failed to rename tmux session" },
      { status: 500 }
    );
  }
}
