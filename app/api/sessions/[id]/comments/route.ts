import { NextRequest, NextResponse } from "next/server";
import {
  createComment,
  listComments,
  CommentValidationError,
} from "@/lib/session-comments";

// GET /api/sessions/[id]/comments → list comments for a session (oldest first)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    return NextResponse.json({ comments: listComments(id) });
  } catch (error) {
    console.error("comments GET failed:", error);
    return NextResponse.json(
      { error: "Failed to list comments" },
      { status: 500 }
    );
  }
}

// POST /api/sessions/[id]/comments { body, author? } → create
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
    const { id } = await params;
    const { body: commentBody, author } = (body ?? {}) as {
      body?: unknown;
      author?: unknown;
    };
    const comment = createComment({
      sessionId: id,
      body: commentBody,
      author,
    });
    return NextResponse.json({ comment }, { status: 201 });
  } catch (error) {
    if (error instanceof CommentValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("comments POST failed:", error);
    return NextResponse.json(
      { error: "Failed to create comment" },
      { status: 500 }
    );
  }
}
