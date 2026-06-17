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
import { getDb, queries } from "@/lib/db";

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
    // confirm any referenced resource exists. Any failure degrades to an answer
    // (never a card).
    const validated = validateProposal(parsed.data);
    if (!validated.ok) {
      auditCommand("command_rejected", {
        stage: "propose",
        reason: validated.reason,
        raw: parsed.data,
      });
      return NextResponse.json({
        kind: "answer",
        text: `I can only run a small set of safe actions, and I couldn't do that one (${validated.reason}). I can create a new session, create a dispatch task, navigate to a view, or list your sessions — what would you like?`,
      });
    }

    const proposal = validated.proposal;

    // open_view and list_sessions need no server-side resource resolution.
    if (
      proposal.action === "open_view" ||
      proposal.action === "list_sessions"
    ) {
      const summary = describeProposal(proposal, "");
      auditCommand("command_proposed", { proposal });
      return NextResponse.json({
        kind: "proposal",
        action: proposal.action,
        params: proposal.params,
        summary,
        // Provide a synthetic sentinel project so the client type contract is
        // consistent (the client card shows summary, not project.name for these).
        project: { id: "", name: "" },
      });
    }

    // create_session: project must exist.
    if (proposal.action === "create_session") {
      const project = projectRows.find(
        (p) => p.id === proposal.params.projectId
      );
      if (!project) {
        auditCommand("command_rejected", {
          stage: "propose",
          reason: "unknown project",
          proposal,
        });
        return NextResponse.json({
          kind: "answer",
          text: "I couldn't match that to one of your projects. Which project should I create the session in?",
        });
      }

      const summary = describeProposal(proposal, project.name);
      auditCommand("command_proposed", {
        proposal,
        project: { id: project.id, name: project.name },
      });

      return NextResponse.json({
        kind: "proposal",
        action: proposal.action,
        params: proposal.params,
        summary,
        project: { id: project.id, name: project.name },
      });
    }

    // dispatch_issue: validate the repoId is known (read-only DB check here).
    if (proposal.action === "dispatch_issue") {
      const db = getDb();
      const repo = queries.getDispatchRepo(db).get(proposal.params.repoId);
      if (!repo) {
        auditCommand("command_rejected", {
          stage: "propose",
          reason: "unknown dispatch repo",
          proposal,
        });
        return NextResponse.json({
          kind: "answer",
          text: "I couldn't find a dispatch repo with that id. Check the Dispatch view for the configured repos.",
        });
      }

      const repoRow = repo as { id: string; repo_slug: string };
      const summary = describeProposal(proposal, repoRow.repo_slug);
      auditCommand("command_proposed", { proposal, repoSlug: repoRow.repo_slug });

      return NextResponse.json({
        kind: "proposal",
        action: proposal.action,
        params: proposal.params,
        summary,
        project: { id: repoRow.id, name: repoRow.repo_slug },
      });
    }

    // Unreachable — validateProposal is exhaustive over COMMAND_ACTION_IDS.
    return NextResponse.json({ kind: "answer", text: "I'm not sure how to handle that action." });
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
