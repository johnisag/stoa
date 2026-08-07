import { NextRequest, NextResponse } from "next/server";
import { promptSession, type WaitTargetStatus } from "@/lib/agent-coordination";
import { parseJsonBody, SEND_KEYS_MAX_LENGTH } from "@/lib/api-security";

const VALID_TARGETS = new Set<WaitTargetStatus>([
  "running",
  "waiting",
  "idle",
  "error",
  "dead",
]);

// Reject C0 control characters except tab and newline, which are intentional
// terminal input. Same guard as the send-keys route.
function hasDisallowedControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10) return true;
    if (code === 127) return true;
  }
  return false;
}

/**
 * POST /api/sessions/[id]/prompt — send a prompt to a session and optionally
 * wait for a target status. The Stoa equivalent of Herdr's
 * `herdr agent prompt <target> <text>`.
 *
 * Combines send-keys + wait into a single call for agent-to-agent flows.
 *
 * Body:
 *   { text: string,                  // required: the prompt text
 *     pressEnter?: boolean,           // default true
 *     waitFor?: "running"|"waiting"|"idle"|"error"|"dead",
 *     timeoutMs?: number,             // default 120000, max 300000
 *     pollIntervalMs?: number }       // default 1000, min 250
 *
 * Reply: { sent: true, waitResult?: { status, matched, elapsedMs, lastLine } }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const parsed = await parseJsonBody<{
    text?: string;
    pressEnter?: boolean;
    waitFor?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }>(request);
  if (!parsed.ok) return parsed.response;

  try {
    const { id } = await params;
    const {
      text,
      pressEnter = true,
      waitFor,
      timeoutMs,
      pollIntervalMs,
    } = parsed.data;

    if (!text) {
      return NextResponse.json({ error: "No text provided" }, { status: 400 });
    }

    if (text.length > SEND_KEYS_MAX_LENGTH) {
      return NextResponse.json(
        { error: `Text exceeds maximum length of ${SEND_KEYS_MAX_LENGTH}` },
        { status: 400 }
      );
    }

    if (hasDisallowedControlChars(text)) {
      return NextResponse.json(
        { error: "Text contains disallowed control characters" },
        { status: 400 }
      );
    }

    if (waitFor && !VALID_TARGETS.has(waitFor as WaitTargetStatus)) {
      return NextResponse.json(
        {
          error: `Invalid waitFor status. Must be one of: ${[...VALID_TARGETS].join(", ")}`,
        },
        { status: 400 }
      );
    }

    const result = await promptSession(id, text, {
      pressEnter,
      waitFor: waitFor as WaitTargetStatus | undefined,
      timeoutMs,
      pollIntervalMs,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }
    return NextResponse.json({
      sent: result.sent,
      waitResult: result.waitResult,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[prompt] Error:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
