import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Message } from "@/lib/db";
import { parseJsonBody, MESSAGE_CONTENT_MAX_LENGTH } from "@/lib/api-security";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/sessions/[id]/messages - Get all messages for a session
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();

    // Verify session exists
    const session = queries.getSession(db).get(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const messages = queries.getSessionMessages(db).all(id) as Message[];

    return NextResponse.json({ messages });
  } catch (error) {
    console.error("Error fetching messages:", error);
    return NextResponse.json(
      { error: "Failed to fetch messages" },
      { status: 500 }
    );
  }
}

// POST /api/sessions/[id]/messages - Add a message (for user messages)
export async function POST(request: NextRequest, { params }: RouteParams) {
  const parsed = await parseJsonBody<{
    role?: string;
    content?: string;
  }>(request);
  if (!parsed.ok) return parsed.response;

  const { role, content } = parsed.data;

  if (!role || !content) {
    return NextResponse.json(
      { error: "Role and content are required" },
      { status: 400 }
    );
  }

  if (role !== "user" && role !== "assistant") {
    return NextResponse.json(
      { error: "role must be 'user' or 'assistant'" },
      { status: 400 }
    );
  }

  if (content.length > MESSAGE_CONTENT_MAX_LENGTH) {
    return NextResponse.json(
      { error: "content exceeds maximum length" },
      { status: 400 }
    );
  }

  try {
    const { id } = await params;
    const db = getDb();

    // Verify session exists
    const session = queries.getSession(db).get(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const result = queries
      .createMessage(db)
      .run(id, role, JSON.stringify([{ type: "text", text: content }]), null);

    return NextResponse.json(
      {
        id: result.lastInsertRowid,
        session_id: id,
        role,
        content,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error creating message:", error);
    return NextResponse.json(
      { error: "Failed to create message" },
      { status: 500 }
    );
  }
}
