import { NextRequest, NextResponse } from "next/server";
import {
  ASK_PROVIDERS,
  gatherStoaContext,
  runAsk,
  type AskHistoryTurn,
  type AskProvider,
} from "@/lib/ask";
import { getModelOptions } from "@/lib/model-catalog";
import { getAllProjects } from "@/lib/projects";
import {
  buildCommandPrompt,
  parseAgentReply,
  type CommandProject,
} from "@/lib/command/plan";
import { validateProposal, describeProposal } from "@/lib/command/actions";
import { auditCommand } from "@/lib/command/audit";

/**
 * POST /api/command/propose — the chatbox's brain. Runs the user's message
 * through the selected agent, which either ANSWERS (prose, like Ask Stoa) or
 * PROPOSES an allowlisted action. NOTHING is executed here: a proposal is
 * validated against the fail-closed allowlist (lib/command/actions) and returned
 * as a confirm card for the user to approve. A proposal that fails validation, or
 * names an unknown project, degrades to a plain answer — a bad/over-reaching
 * proposal can never become an actionable card.
 *
 * Body:  { message: string,
 *          history?: { role: "user" | "assistant"; content: string }[],
 *          provider?: "claude" | "codex",   // default "claude"
 *          model?: string }                 // a getModelOptions(provider) token
 * Reply: { kind: "answer", text }
 *      |  { kind: "proposal", action, params, summary, project: { id, name } }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      message: rawMessage,
      history: rawHistory,
      provider: rawProvider,
      model: rawModel,
    } = body as {
      message?: unknown;
      history?: unknown;
      provider?: unknown;
      model?: unknown;
    };

    const message = typeof rawMessage === "string" ? rawMessage.trim() : "";
    if (!message) {
      return NextResponse.json(
        { error: "A non-empty message is required" },
        { status: 400 }
      );
    }

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

    // Model: honored only if it's a value from the provider's catalog (a fixed
    // token, never free text), else the agent's own default. Same guard as
    // /api/ask — keeps an arbitrary string out of the argv model flag.
    const model =
      typeof rawModel === "string" &&
      getModelOptions(provider).some((o) => o.value === rawModel)
        ? rawModel
        : undefined;

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

    // Gather the same grounded context as Ask Stoa, plus the projects the planner
    // may target (id/name/dir). The directory is shown for the agent's reasoning
    // only — the executor re-derives it from projectId, never trusts the agent.
    const projectRows = getAllProjects();
    const projects: CommandProject[] = projectRows.map((p) => ({
      id: p.id,
      name: p.name,
      directory: p.working_directory,
      agentType: p.agent_type,
    }));
    const context = await gatherStoaContext();
    const prompt = buildCommandPrompt({ context, projects, history, message });

    let reply: string;
    try {
      reply = await runAsk(provider, prompt, { model });
    } catch (err) {
      console.error(`[command] ${provider} planner failed:`, err);
      return NextResponse.json(
        { error: `Couldn't reach the ${provider} agent` },
        { status: 502 }
      );
    }

    const parsed = parseAgentReply(reply);
    if (parsed.kind === "answer") {
      return NextResponse.json({ kind: "answer", text: parsed.text });
    }

    // A proposal: validate the SHAPE against the fail-closed allowlist, then
    // confirm the project exists. Any failure degrades to an answer (never a card).
    const validated = validateProposal(parsed.data);
    if (!validated.ok) {
      auditCommand("command_rejected", {
        stage: "propose",
        reason: validated.reason,
        raw: parsed.data,
      });
      return NextResponse.json({
        kind: "answer",
        text: `I can only run a small set of safe actions, and I couldn't do that one (${validated.reason}). I can create a new session for you — tell me which project and which agent.`,
      });
    }

    const project = projectRows.find(
      (p) => p.id === validated.proposal.params.projectId
    );
    if (!project) {
      auditCommand("command_rejected", {
        stage: "propose",
        reason: "unknown project",
        proposal: validated.proposal,
      });
      return NextResponse.json({
        kind: "answer",
        text: "I couldn't match that to one of your projects. Which project should I create the session in?",
      });
    }

    const summary = describeProposal(validated.proposal, project.name);
    auditCommand("command_proposed", {
      proposal: validated.proposal,
      project: { id: project.id, name: project.name },
    });

    return NextResponse.json({
      kind: "proposal",
      action: validated.proposal.action,
      params: validated.proposal.params,
      summary,
      project: { id: project.id, name: project.name },
    });
  } catch (error) {
    // Unexpected throw — audit it so the ledger has no blind spot, then 500.
    console.error("Error proposing command:", error);
    auditCommand("command_failed", {
      stage: "propose",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    const messageText =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: messageText }, { status: 500 });
  }
}
