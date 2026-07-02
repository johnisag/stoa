import { NextRequest, NextResponse } from "next/server";
import { getProject } from "@/lib/projects";
import { getDb, queries } from "@/lib/db";
import { validateProposal } from "@/lib/command/actions";
import { executeCreateSession } from "@/lib/command/create-session";
import { executeDispatchIssue } from "@/lib/command/dispatch-issue";
import { executeListSessions } from "@/lib/command/list-sessions";
import { executeBestOfN } from "@/lib/command/best-of-n-action";
import { executePlan } from "@/lib/command/execute-plan";
import { auditCommand } from "@/lib/command/audit";
import type { DispatchRepo } from "@/lib/dispatch/types";

/**
 * POST /api/command/execute — run a confirmed command. The user has approved a
 * proposal in the chatbox; this is the ONLY place a command actually takes effect.
 *
 * Defense-in-depth: the body is RE-VALIDATED against the same fail-closed
 * allowlist (lib/command/actions) — the client is never trusted, even though
 * /propose already validated. Resources are resolved SERVER-SIDE from their ids
 * (never an agent/client-supplied path). Creation runs in-process via typed
 * executors — no self-fetch, so there's no Host-derived origin to abuse. Every
 * outcome is appended to the audit ledger.
 *
 * Supported actions:
 *   create_session  → { ok, sessionId, name, initialPrompt?, project }
 *   dispatch_issue  → { ok, dispatchId, title, repoSlug }
 *   open_view       → { ok, clientAction: "open_view", view }  (client navigates)
 *   list_sessions   → { ok, sessions: SessionSummary[], total }
 */
export async function POST(request: NextRequest) {
  // Parse the body once, outside the try, so the catch block can include plan
  // context in the audit entry without re-reading the already-consumed stream.
  const body = await request.json().catch(() => ({}));
  try {
    // Plan execution: body carries { kind: "plan", name, steps }. Delegate to the
    // sequential plan executor (which re-validates all steps internally).
    if ((body as Record<string, unknown>).kind === "plan") {
      const result = await executePlan(body);
      if (!result.ok) {
        return NextResponse.json(
          { error: `Refused: ${result.reason}` },
          { status: 400 }
        );
      }
      return NextResponse.json({ ok: true, results: result.results });
    }

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

    const proposal = validated.proposal;

    // ── create_session ──────────────────────────────────────────────────────
    if (proposal.action === "create_session") {
      const project = getProject(proposal.params.projectId);
      if (!project) {
        auditCommand("command_rejected", {
          stage: "execute",
          reason: "unknown project",
          proposal,
        });
        return NextResponse.json({ error: "Unknown project" }, { status: 400 });
      }

      let created: { id: string; name: string; initialPrompt?: string };
      try {
        created = executeCreateSession(proposal.params, {
          id: project.id,
          working_directory: project.working_directory,
          default_model: project.default_model,
        });
      } catch (err) {
        console.error("[command] create_session failed:", err);
        auditCommand("command_failed", {
          action: "create_session",
          params: proposal.params,
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
        params: proposal.params,
        sessionId: created.id,
        project: { id: project.id, name: project.name },
      });

      return NextResponse.json({
        ok: true,
        sessionId: created.id,
        name: created.name,
        ...(created.initialPrompt !== undefined
          ? { initialPrompt: created.initialPrompt }
          : {}),
        project: { id: project.id, name: project.name },
      });
    }

    // ── dispatch_issue ───────────────────────────────────────────────────────
    if (proposal.action === "dispatch_issue") {
      const db = getDb();
      const repo = queries.getDispatchRepo(db).get(proposal.params.repoId) as
        DispatchRepo | undefined;
      if (!repo) {
        auditCommand("command_rejected", {
          stage: "execute",
          reason: "unknown dispatch repo",
          proposal,
        });
        return NextResponse.json(
          { error: "Unknown dispatch repo" },
          { status: 400 }
        );
      }

      let created: { dispatchId: string; title: string; repoSlug: string };
      try {
        created = executeDispatchIssue(proposal.params, {
          id: repo.id,
          repo_slug: repo.repo_slug,
        });
      } catch (err) {
        console.error("[command] dispatch_issue failed:", err);
        auditCommand("command_failed", {
          action: "dispatch_issue",
          params: proposal.params,
          repoId: proposal.params.repoId,
          error: err instanceof Error ? err.message : "unknown error",
        });
        return NextResponse.json(
          { error: "Failed to create the dispatch task" },
          { status: 502 }
        );
      }

      auditCommand("command_executed", {
        action: "dispatch_issue",
        params: proposal.params,
        dispatchId: created.dispatchId,
        repoSlug: created.repoSlug,
      });

      return NextResponse.json({
        ok: true,
        dispatchId: created.dispatchId,
        title: created.title,
        repoSlug: created.repoSlug,
      });
    }

    // ── open_view ────────────────────────────────────────────────────────────
    if (proposal.action === "open_view") {
      auditCommand("command_executed", {
        action: "open_view",
        params: proposal.params,
      });
      // open_view is a client-side navigation instruction — nothing runs on the
      // server. The clientAction field tells the ChatView to switch tabs.
      return NextResponse.json({
        ok: true,
        clientAction: "open_view",
        view: proposal.params.view,
      });
    }

    // ── list_sessions ────────────────────────────────────────────────────────
    if (proposal.action === "list_sessions") {
      let result: { sessions: unknown[]; total: number };
      try {
        result = executeListSessions(proposal.params);
      } catch (err) {
        console.error("[command] list_sessions failed:", err);
        auditCommand("command_failed", {
          action: "list_sessions",
          params: proposal.params,
          error: err instanceof Error ? err.message : "unknown error",
        });
        return NextResponse.json(
          { error: "Failed to list sessions" },
          { status: 502 }
        );
      }

      auditCommand("command_executed", {
        action: "list_sessions",
        params: proposal.params,
        total: result.total,
      });

      return NextResponse.json({ ok: true, ...result });
    }

    // ── best_of_n ────────────────────────────────────────────────────────────
    if (proposal.action === "best_of_n") {
      const project = getProject(proposal.params.projectId);
      if (!project) {
        auditCommand("command_rejected", {
          stage: "execute",
          reason: "unknown project",
          proposal,
        });
        return NextResponse.json({ error: "Unknown project" }, { status: 400 });
      }

      let result: { runId: string; n: number };
      try {
        result = await executeBestOfN(proposal.params, {
          id: project.id,
          working_directory: project.working_directory,
        });
      } catch (err) {
        console.error("[command] best_of_n failed:", err);
        auditCommand("command_failed", {
          action: "best_of_n",
          params: proposal.params,
          project: { id: project.id, name: project.name },
          error: err instanceof Error ? err.message : "unknown error",
        });
        return NextResponse.json(
          { error: "Failed to start Best-of-N run" },
          { status: 502 }
        );
      }

      auditCommand("command_executed", {
        action: "best_of_n",
        params: proposal.params,
        runId: result.runId,
        project: { id: project.id, name: project.name },
      });

      return NextResponse.json({
        ok: true,
        clientAction: "open_best_of_n",
        runId: result.runId,
        n: result.n,
        project: { id: project.id, name: project.name },
      });
    }

    // Should never reach here — validateProposal is exhaustive over the allowlist.
    return NextResponse.json({ error: "Unhandled action" }, { status: 400 });
  } catch (error) {
    // Unexpected throw before the inner handlers (e.g. a DB fault in getProject):
    // audit it so the ledger has no blind spot, then surface a 500. Include the
    // plan name/kind when the body carried a plan so the audit entry has context
    // (body is hoisted above the try so it's in scope here).
    console.error("Error executing command:", error);
    const b = body as Record<string, unknown>;
    auditCommand("command_failed", {
      stage: "execute",
      ...(b.kind === "plan" ? { kind: "plan", planName: b.name } : {}),
      error: error instanceof Error ? error.message : "Unknown error",
    });
    const messageText =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: messageText }, { status: 500 });
  }
}
