import { NextRequest, NextResponse } from "next/server";
import {
  updateComment,
  deleteComment,
  CommentValidationError,
} from "@/lib/session-comments";

// PATCH /api/sessions/[id]/comments/[commentId] { body } → update (session-scoped)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; commentId: string }> }
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
    const { id, commentId } = await params;
    const { body: commentBody } = (body ?? {}) as { body?: unknown };
    const comment = updateComment(id, commentId, commentBody);
    if (!comment) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }
    return NextResponse.json({ comment });
  } catch (error) {
    if (error instanceof CommentValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("comment PATCH failed:", error);
    return NextResponse.json(
      { error: "Failed to update comment" },
      { status: 500 }
    );
  }
}

// DELETE /api/sessions/[id]/comments/[commentId] → delete (session-scoped)
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; commentId: string }> }
) {
  try {
    const { id, commentId } = await params;
    const removed = deleteComment(id, commentId);
    if (!removed) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("comment DELETE failed:", error);
    return NextResponse.json(
      { error: "Failed to delete comment" },
      { status: 500 }
    );
  }
}
