import { NextRequest, NextResponse } from "next/server";
import { ASK_PROVIDERS, runAsk, type AskProvider } from "@/lib/ask";
import { getModelOptions } from "@/lib/model-catalog";
import { getAllProjects } from "@/lib/projects";
import {
  buildGenerateWorkflowPrompt,
  parseAgentReply,
} from "@/lib/command/plan";
import { validateWorkflowProposal } from "@/lib/command/actions";
import { auditCommand } from "@/lib/command/audit";

// A role-fleet design is a bigger generation than a one-line answer, so allow more
// wall-clock than the 60s Ask default. runAsk tree-kills the child on timeout, so a
// hung/interactive model degrades to a clean 502 → answer, never a wedged request.
const GENERATE_TIMEOUT_MS = 120_000;

/**
 * POST /api/command/generate-workflow — the "assisted design workflow" brain.
 *
 * Runs the user's goal through the selected agent, which DESIGNS a role-fleet
 * workflow as a single strict-JSON object. NOTHING is executed here: the design is
 * validated by the SAME fail-closed gate hand-built specs pass
 * (validateWorkflowProposal → validateSpec) and returned as a laid-out DRAFT
 * BuilderDoc for the visual canvas. The user reviews/edits it and SEPARATELY
 * chooses whether to run it. A prose reply, an invalid design, or a spawn failure
 * all degrade to a plain answer / error — never a broken or auto-running canvas.
 *
 * Body:  { summary: string, projectId: string,
 *          provider?: "claude" | "codex",   // default "claude"
 *          model?: string }                 // a getModelOptions(provider) token
 * Reply: { kind: "answer", text }
 *      |  { kind: "workflow", doc, project: { id, name } }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      summary: rawSummary,
      projectId: rawProjectId,
      provider: rawProvider,
      model: rawModel,
    } = body as {
      summary?: unknown;
      projectId?: unknown;
      provider?: unknown;
      model?: unknown;
    };

    const summary = typeof rawSummary === "string" ? rawSummary.trim() : "";
    if (!summary) {
      return NextResponse.json(
        { error: "A non-empty summary is required" },
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

    // Model: honored only if it's a token from the provider's static catalog
    // (never free text) — same guard as /api/ask, keeps an arbitrary string out of
    // the argv model flag.
    const model =
      typeof rawModel === "string" &&
      getModelOptions(provider).some((o) => o.value === rawModel)
        ? rawModel
        : undefined;

    // Resolve the project SERVER-SIDE — the agent never supplies a path. A
    // missing/unknown project degrades to a helpful answer (the UI picks one).
    const projectId =
      typeof rawProjectId === "string" ? rawProjectId.trim() : "";
    const project = projectId
      ? getAllProjects().find((p) => p.id === projectId)
      : undefined;
    if (!project) {
      return NextResponse.json({
        kind: "answer",
        text: "Tell me which project to design the workflow for, and I'll lay it out.",
      });
    }

    // No fleet context here: a workflow DESIGN is grounded by the goal + project +
    // role list, not by what the fleet is doing right now — and gatherStoaContext()
    // does a live capture of every terminal (latency, zero design signal). Skip it.
    const prompt = buildGenerateWorkflowPrompt({
      summary,
      projectName: project.name,
      projectDir: project.working_directory,
    });

    let reply: string;
    try {
      reply = await runAsk(provider, prompt, {
        model,
        timeoutMs: GENERATE_TIMEOUT_MS,
      });
    } catch (err) {
      console.error(`[generate-workflow] ${provider} designer failed:`, err);
      auditCommand("workflow_failed", {
        stage: "generate",
        reason: err instanceof Error ? err.message : "spawn failed",
      });
      return NextResponse.json(
        { error: `Couldn't reach the ${provider} agent` },
        { status: 502 }
      );
    }

    const parsed = parseAgentReply(reply);
    if (parsed.kind !== "workflow") {
      // Not a design: surface the agent's prose (kind "answer") so a clarifying
      // question reaches the user. The only other case is a stray create_session-
      // shaped "proposal" in a design context — treat it as a failed design.
      const text =
        parsed.kind === "answer"
          ? parsed.text
          : "I couldn't turn that into a workflow — try describing the goal in more detail.";
      return NextResponse.json({ kind: "answer", text });
    }

    // Validate the design against the fail-closed gate, with the working directory
    // set from the resolved project. Any failure degrades to an answer naming the
    // first problem (never a broken or runnable canvas).
    const validated = validateWorkflowProposal(parsed.data, {
      projectId: project.id,
      projectDir: project.working_directory,
    });
    if (!validated.ok) {
      auditCommand("workflow_rejected", {
        stage: "generate",
        reason: validated.reason,
      });
      return NextResponse.json({
        kind: "answer",
        text: `I designed a workflow but it didn't pass validation (${validated.reason}). Add a bit more detail to the goal and I'll regenerate.`,
      });
    }

    auditCommand("workflow_proposed", {
      project: { id: project.id, name: project.name },
      steps: validated.doc.nodes.length,
    });
    return NextResponse.json({
      kind: "workflow",
      doc: validated.doc,
      project: { id: project.id, name: project.name },
    });
  } catch (error) {
    // Unexpected throw — audit it so the ledger has no blind spot, then 500.
    console.error("Error generating workflow:", error);
    auditCommand("workflow_failed", {
      stage: "generate",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
