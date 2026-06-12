import { NextRequest, NextResponse } from "next/server";
import {
  ASK_PROVIDERS,
  buildAskPrompt,
  gatherStoaContext,
  runAsk,
  type AskHistoryTurn,
  type AskProvider,
} from "@/lib/ask";

/**
 * POST /api/ask — answer a natural-language question about the user's Stoa fleet.
 *
 * READ-ONLY: gathers a compact context from Stoa's own data, builds a grounded
 * prompt, and runs the user-SELECTED agent in non-interactive mode to produce the
 * answer. Nothing here mutates state, forks, or sends keystrokes to a live
 * session.
 *
 * Body:  { question: string,
 *          history?: { role: "user" | "assistant"; content: string }[],
 *          provider: "claude" | "codex" | "hermes" }
 * Reply: { answer } on success, or { error } with a 4xx/5xx status.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      question: rawQuestion,
      history: rawHistory,
      provider: rawProvider,
    } = body as {
      question?: unknown;
      history?: unknown;
      provider?: unknown;
    };

    // Validate the question (non-empty string).
    const question = typeof rawQuestion === "string" ? rawQuestion.trim() : "";
    if (!question) {
      return NextResponse.json(
        { error: "A non-empty question is required" },
        { status: 400 }
      );
    }

    // Validate the provider (default "claude"; reject anything outside the set).
    if (
      rawProvider !== undefined &&
      !ASK_PROVIDERS.includes(rawProvider as AskProvider)
    ) {
      return NextResponse.json(
        {
          error: `Unknown provider — choose one of: ${ASK_PROVIDERS.join(", ")}`,
        },
        { status: 400 }
      );
    }
    const provider: AskProvider =
      rawProvider === undefined ? "claude" : (rawProvider as AskProvider);

    // Normalize history: keep only well-formed {role, content} turns.
    const history: AskHistoryTurn[] = Array.isArray(rawHistory)
      ? rawHistory
          .filter(
            (t): t is AskHistoryTurn =>
              !!t &&
              typeof t === "object" &&
              ((t as AskHistoryTurn).role === "user" ||
                (t as AskHistoryTurn).role === "assistant") &&
              typeof (t as AskHistoryTurn).content === "string"
          )
          .map((t) => ({ role: t.role, content: t.content }))
      : [];

    // Gather context, build the grounded prompt, run the selected agent.
    const context = await gatherStoaContext();
    const prompt = buildAskPrompt({ context, history, question });

    let answer: string;
    try {
      answer = await runAsk(provider, prompt);
    } catch (err) {
      console.error(`[ask] ${provider} agent failed:`, err);
      return NextResponse.json(
        { error: `Couldn't reach the ${provider} agent` },
        { status: 502 }
      );
    }

    if (!answer) {
      return NextResponse.json(
        { error: `The ${provider} agent returned an empty answer` },
        { status: 502 }
      );
    }

    return NextResponse.json({ answer });
  } catch (error) {
    console.error("Error answering question:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
