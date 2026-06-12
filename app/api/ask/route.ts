import { NextRequest, NextResponse } from "next/server";
import {
  ASK_PROVIDERS,
  buildAskPrompt,
  gatherStoaContext,
  runAsk,
  type AskHistoryTurn,
  type AskProvider,
} from "@/lib/ask";
import { getModelOptions } from "@/lib/model-catalog";

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
 *          provider?: "claude" | "codex",   // default "claude"
 *          model?: string }                 // a getModelOptions(provider) token;
 *                                            // anything else → the agent's default
 * Reply: { answer } on success, or { error } with a 4xx/5xx status.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      question: rawQuestion,
      history: rawHistory,
      provider: rawProvider,
      model: rawModel,
    } = body as {
      question?: unknown;
      history?: unknown;
      provider?: unknown;
      model?: unknown;
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

    // Validate the model SERVER-SIDE: only a value from the provider's catalog is
    // honored (a fixed token, never user free-text), else fall through to the
    // agent's own default. So a crafted body can't smuggle an arbitrary string
    // into the argv `--model`/`-c model=` flag.
    const model =
      typeof rawModel === "string" &&
      getModelOptions(provider).some((o) => o.value === rawModel)
        ? rawModel
        : undefined;

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
      answer = await runAsk(provider, prompt, { model });
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
