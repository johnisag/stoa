import { NextRequest, NextResponse } from "next/server";
import {
  createComment,
  listComments,
  CommentValidationError,
} from "@/lib/session-comments";
import { checkRateLimit } from "@/lib/api-security";
import { getDb, queries } from "@/lib/db";

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
  const rate = checkRateLimit(request);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rate.retryAfter ?? 60) } }
    );
  }
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
    // Validate the session exists before creating a comment.
    const session = queries.getSession(getDb()).get(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
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
