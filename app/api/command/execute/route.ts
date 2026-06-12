import { NextRequest, NextResponse } from "next/server";
import { getProject } from "@/lib/projects";
import { validateProposal } from "@/lib/command/actions";
import { executeCreateSession } from "@/lib/command/create-session";
import { auditCommand } from "@/lib/command/audit";

/**
 * POST /api/command/execute — run a confirmed command. The user has approved a
 * proposal in the chatbox; this is the ONLY place a command actually takes effect.
 *
 * Defense-in-depth: the body is RE-VALIDATED against the same fail-closed
 * allowlist (lib/command/actions) — the client is never trusted, even though
 * /propose already validated. The working directory is derived SERVER-SIDE from
 * the chosen projectId (never an agent/client-supplied path). Creation runs
 * in-process via executeCreateSession (the plain-session subset of the typed
 * sessions logic) — no self-fetch, so there's no Host-derived origin to abuse.
 * Every outcome is appended to the audit ledger.
 *
 * Body:  { action: "create_session", params: { projectId, agentType, model?,
 *          name? } }
 * Reply: { ok: true, sessionId, name, project: { id, name } } | { error }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { action, params } = body as { action?: unknown; params?: unknown };

    // Re-validate the action SHAPE (defense-in-depth — propose's pass is not
    // trusted on the way back in).
    const validated = validateProposal({ action, params });
    if (!validated.ok) {
      auditCommand("command_rejected", {
        stage: "execute",
        reason: validated.reason,
        body: { action, params },
      });
      return NextResponse.json(
        { error: `Refused: ${validated.reason}` },
        { status: 400 }
      );
    }

    // Resolve the project SERVER-SIDE — this is where the working directory comes
    // from, not the proposal. A vanished/unknown project fails closed.
    const project = getProject(validated.proposal.params.projectId);
    if (!project) {
      auditCommand("command_rejected", {
        stage: "execute",
        reason: "unknown project",
        proposal: validated.proposal,
      });
      return NextResponse.json({ error: "Unknown project" }, { status: 400 });
    }

    let created: { id: string; name: string };
    try {
      created = executeCreateSession(validated.proposal.params, {
        id: project.id,
        working_directory: project.working_directory,
        default_model: project.default_model,
      });
    } catch (err) {
      console.error("[command] create_session failed:", err);
      auditCommand("command_failed", {
        action: "create_session",
        params: validated.proposal.params,
        project: { id: project.id, name: project.name },
        error: err instanceof Error ? err.message : "unknown error",
      });
      return NextResponse.json(
        { error: "Failed to create the session" },
        { status: 502 }
      );
    }

    auditCommand("command_executed", {
      action: "create_session",
      params: validated.proposal.params,
      sessionId: created.id,
      project: { id: project.id, name: project.name },
    });

    return NextResponse.json({
      ok: true,
      sessionId: created.id,
      name: created.name,
      project: { id: project.id, name: project.name },
    });
  } catch (error) {
    // Unexpected throw before the inner handlers (e.g. a DB fault in getProject):
    // audit it so the ledger has no blind spot, then surface a 500.
    console.error("Error executing command:", error);
    auditCommand("command_failed", {
      stage: "execute",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    const messageText =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: messageText }, { status: 500 });
  }
}
