import { NextRequest, NextResponse } from "next/server";
import {
  setMemory,
  getMemory,
  listMemory,
  deleteMemory,
  MemoryValidationError,
} from "@/lib/agent-memory";

// Agent-accessible shared memory — the SAME endpoint the orchestration MCP
// server's memory_* tools call (and the shared surface a human UI would use). A
// fleet-wide key→value scratchpad for cross-agent coordination. Values are
// stored/returned as DATA (an agent reads a key on demand; nothing is
// auto-injected into a terminal).

// GET /api/memory          → list all entries (newest first)
// GET /api/memory?key=foo  → one entry, or 404 if unset
export async function GET(request: NextRequest) {
  try {
    const key = request.nextUrl.searchParams.get("key");
    if (key != null) {
      const entry = getMemory(key);
      if (!entry) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      return NextResponse.json({ entry });
    }
    return NextResponse.json({ entries: listMemory() });
  } catch (error) {
    if (error instanceof MemoryValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("memory GET failed:", error);
    return NextResponse.json(
      { error: "Failed to read memory" },
      { status: 500 }
    );
  }
}

// POST /api/memory { key, value } → upsert
export async function POST(request: NextRequest) {
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
    const { key, value } = (body ?? {}) as { key?: unknown; value?: unknown };
    const entry = setMemory(key, value);
    return NextResponse.json({ entry }, { status: 201 });
  } catch (error) {
    if (error instanceof MemoryValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("memory POST failed:", error);
    return NextResponse.json(
      { error: "Failed to write memory" },
      { status: 500 }
    );
  }
}

// DELETE /api/memory?key=foo → remove one entry
export async function DELETE(request: NextRequest) {
  try {
    const key = request.nextUrl.searchParams.get("key");
    const removed = deleteMemory(key);
    return NextResponse.json({ removed });
  } catch (error) {
    if (error instanceof MemoryValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("memory DELETE failed:", error);
    return NextResponse.json(
      { error: "Failed to delete memory" },
      { status: 500 }
    );
  }
}
