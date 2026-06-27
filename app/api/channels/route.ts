import { NextRequest, NextResponse } from "next/server";
import {
  sendChannelMessage,
  peekInbox,
  consumeInbox,
  listThread,
  ChannelValidationError,
} from "@/lib/channels";

// Inter-agent channels — the SAME endpoint the orchestration MCP server's
// channel_* tools call (and the shared surface a human UI would use). Persistent
// 1:1 messages between two sessions so sibling workers can coordinate.
//
// GET  /api/channels?session=<id>             → unread inbox (NON-consuming peek)
// GET  /api/channels?session=<id>&peer=<id>   → the full thread with a peer
// POST /api/channels { from, to, body }       → send a message
// PATCH /api/channels { session }             → consume the inbox (returns the
//                                               unread messages AND marks them read)

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(request: NextRequest) {
  try {
    const session = request.nextUrl.searchParams.get("session");
    const peer = request.nextUrl.searchParams.get("peer");
    if (!session) return badRequest("session is required");
    if (peer != null) {
      return NextResponse.json({ messages: listThread(session, peer) });
    }
    return NextResponse.json({ messages: peekInbox(session) });
  } catch (error) {
    if (error instanceof ChannelValidationError) {
      return badRequest(error.message);
    }
    console.error("channels GET failed:", error);
    return NextResponse.json(
      { error: "Failed to read channel" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  try {
    const {
      from,
      to,
      body: text,
    } = (body ?? {}) as {
      from?: unknown;
      to?: unknown;
      body?: unknown;
    };
    const message = sendChannelMessage({ from, to, body: text });
    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    if (error instanceof ChannelValidationError) {
      return badRequest(error.message);
    }
    console.error("channels POST failed:", error);
    return NextResponse.json(
      { error: "Failed to send message" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  try {
    const { session } = (body ?? {}) as { session?: unknown };
    if (typeof session !== "string" || !session.trim()) {
      return badRequest("session is required");
    }
    return NextResponse.json({ messages: consumeInbox(session) });
  } catch (error) {
    if (error instanceof ChannelValidationError) {
      return badRequest(error.message);
    }
    console.error("channels PATCH failed:", error);
    return NextResponse.json(
      { error: "Failed to read inbox" },
      { status: 500 }
    );
  }
}
