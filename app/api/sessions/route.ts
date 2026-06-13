import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { getDb, queries, type Session, type Group } from "@/lib/db";
import { isValidAgentType, type AgentType } from "@/lib/providers";
import { sessionKey, getProviderDefinition } from "@/lib/providers/registry";
import { resolveModelForAgent } from "@/lib/model-catalog";
import { createWorktree, isStoaWorktree } from "@/lib/worktrees";
import { createWorkspace } from "@/lib/multi-repo-worktree";
import { setupWorktree, type SetupResult } from "@/lib/env-setup";
import { findAvailablePort } from "@/lib/ports";
import { runInBackground } from "@/lib/async-operations";
import { getProject } from "@/lib/projects";
import {
  ensureMcpConfig,
  buildCodexOrchestrationArgs,
  writeConductorMarker,
  ensureHermesMcpRegistered,
} from "@/lib/mcp-config";
import { expandHome } from "@/lib/platform";
import { getLessonsBlockForCwd } from "@/lib/dispatch/lessons";

// GET /api/sessions - List all sessions and groups
export async function GET() {
  try {
    const db = getDb();
    const sessions = queries.getAllSessions(db).all() as Session[];
    const groups = queries.getAllGroups(db).all() as Group[];

    // Convert expanded from 0/1 to boolean
    const formattedGroups = groups.map((g) => ({
      ...g,
      expanded: Boolean(g.expanded),
    }));

    return NextResponse.json({ sessions, groups: formattedGroups });
  } catch (error) {
    console.error("Error fetching sessions:", error);
    return NextResponse.json(
      { error: "Failed to fetch sessions" },
      { status: 500 }
    );
  }
}

// Generate a unique session name
function generateSessionName(db: ReturnType<typeof getDb>): string {
  const sessions = queries.getAllSessions(db).all() as Session[];
  const existingNumbers = sessions
    .map((s) => {
      const match = s.name.match(/^Session (\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => n > 0);

  const nextNumber =
    existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
  return `Session ${nextNumber}`;
}

// POST /api/sessions - Create new session
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const db = getDb();

    const {
      name: providedName,
      workingDirectory = "~",
      parentSessionId = null,
      model: requestedModel = null,
      systemPrompt = null,
      groupPath = "sessions",
      claudeSessionId = null,
      agentType: rawAgentType = "claude",
      autoApprove = false,
      projectId = "uncategorized",
      // Worktree options
      useWorktree = false,
      featureName = null,
      baseBranch = "main",
      // Attach to an existing worktree (recover a deleted session's work)
      // instead of creating a new one.
      existingWorktreePath = null,
      existingWorktreeBranch = null,
      // Multi-repo workspace: when the chosen root holds several git repos, the
      // picked ones ({ path, name }[]) each get a worktree under one workspace dir.
      workspaceRepos = null,
      // Tmux option
      useTmux = true,
      // Initial prompt to send when session starts
      initialPrompt = null,
      // Conductor: write the orchestration MCP (.mcp.json) so this session can
      // spawn worker sessions via the stoa MCP's spawn_worker tool.
      enableOrchestration = false,
    } = body;

    // Validate agent type
    const agentType: AgentType = isValidAgentType(rawAgentType)
      ? rawAgentType
      : "claude";
    const project = projectId ? getProject(projectId) : null;
    const model = resolveModelForAgent(
      agentType,
      (typeof requestedModel === "string" && requestedModel.trim()) ||
        project?.default_model
    );

    // Auto-generate name if not provided
    const name =
      providedName?.trim() ||
      (featureName ? featureName : generateSessionName(db));

    const id = randomUUID();

    // Handle worktree creation if requested
    let worktreePath: string | null = null;
    let branchName: string | null = null;
    let actualWorkingDirectory = workingDirectory;
    let port: number | null = null;
    let setupResult: SetupResult | null = null;
    // Multi-repo workspace: the child worktree paths (for teardown), the repo
    // names + shared branch (for the boundary note), and any repos that failed.
    // Set only in workspace mode.
    let workspacePaths: string[] | null = null;
    let workspaceRepoNames: string[] = [];
    let workspaceBranch: string | null = null;
    let workspaceErrors: { repoName: string; message: string }[] = [];

    if (
      Array.isArray(workspaceRepos) &&
      workspaceRepos.length > 0 &&
      featureName
    ) {
      // Multi-repo workspace: one worktree per picked sub-repo under one workspace
      // dir, which becomes the session's cwd. No single worktree_path/port — the
      // agent works across the subfolders (one branch/PR per repo).
      try {
        const ws = await createWorkspace({
          rootPath: workingDirectory,
          repos: (
            workspaceRepos as Array<{ path: unknown; name: unknown }>
          ).map((r) => ({ path: String(r.path), name: String(r.name) })),
          featureName,
        });
        actualWorkingDirectory = ws.workspacePath;
        workspacePaths = ws.worktrees.map((w) => w.worktreePath);
        workspaceRepoNames = ws.worktrees.map((w) => w.repoName);
        workspaceBranch = ws.worktrees[0]?.branchName ?? null;
        workspaceErrors = ws.errors;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        return NextResponse.json(
          { error: `Failed to create workspace: ${message}` },
          { status: 400 }
        );
      }
    } else if (useWorktree && existingWorktreePath) {
      // Attach to an existing worktree: it's already on disk (with its files +
      // branch + installed deps), so skip createWorktree and setupWorktree —
      // just point the session at it and allocate a dev-server port.
      const attachPath = expandHome(existingWorktreePath);
      // Only attach to an actual Stoa worktree (the picker only ever offers
      // these). Enforce it here too so a crafted request can't point a session
      // at an arbitrary directory under the worktree contract.
      if (!isStoaWorktree(attachPath)) {
        return NextResponse.json(
          { error: "Not a Stoa worktree" },
          { status: 400 }
        );
      }
      if (!existsSync(attachPath)) {
        return NextResponse.json(
          { error: `Worktree no longer exists: ${existingWorktreePath}` },
          { status: 400 }
        );
      }
      worktreePath = attachPath;
      branchName =
        typeof existingWorktreeBranch === "string" && existingWorktreeBranch
          ? existingWorktreeBranch
          : null;
      actualWorkingDirectory = attachPath;
      port = await findAvailablePort();
    } else if (useWorktree && featureName) {
      try {
        const worktreeInfo = await createWorktree({
          projectPath: workingDirectory,
          featureName,
          baseBranch,
        });
        worktreePath = worktreeInfo.worktreePath;
        branchName = worktreeInfo.branchName;
        actualWorkingDirectory = worktreeInfo.worktreePath;

        // Find an available port for the dev server
        port = await findAvailablePort();

        // Run environment setup in background (non-blocking)
        // This allows instant UI feedback while npm install runs async
        const capturedWorktreePath = worktreeInfo.worktreePath;
        const capturedSourcePath = workingDirectory;
        const capturedPort = port;
        runInBackground(async () => {
          const result = await setupWorktree({
            worktreePath: capturedWorktreePath,
            sourcePath: capturedSourcePath,
            port: capturedPort,
          });
          console.log("Worktree setup completed:", {
            port: capturedPort,
            envFilesCopied: result.envFilesCopied,
            stepsRun: result.steps.length,
            success: result.success,
          });
        }, `setup-worktree-${id}`);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        return NextResponse.json(
          { error: `Failed to create worktree: ${message}` },
          { status: 400 }
        );
      }
    }

    const tmuxName = useTmux
      ? sessionKey({ kind: "agent", provider: agentType, id })
      : null;
    queries.createSession(db).run(
      id,
      name,
      tmuxName,
      actualWorkingDirectory,
      parentSessionId,
      model,
      systemPrompt,
      groupPath,
      agentType,
      autoApprove ? 1 : 0, // SQLite stores booleans as integers
      projectId
    );

    // Set worktree info if created
    if (worktreePath) {
      queries
        .updateSessionWorktree(db)
        .run(worktreePath, branchName, baseBranch, port, id);
    }

    // Multi-repo workspace: record the child worktree paths so deleting the
    // session tears every one of them down (see DELETE /api/sessions/[id]).
    if (workspacePaths && workspacePaths.length > 0) {
      queries
        .setSessionWorktreePaths(db)
        .run(JSON.stringify(workspacePaths), id);
    }

    // Set claude_session_id if provided (for importing external sessions)
    if (claudeSessionId) {
      db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?").run(
        claudeSessionId,
        id
      );
    }

    // If forking, copy messages from parent
    if (parentSessionId) {
      const parentMessages = queries
        .getSessionMessages(db)
        .all(parentSessionId);
      for (const msg of parentMessages as Array<{
        role: string;
        content: string;
        duration_ms: number | null;
      }>) {
        queries
          .createMessage(db)
          .run(id, msg.role, msg.content, msg.duration_ms);
      }
    }

    const session = queries.getSession(db).get(id) as Session;

    // Conductor: write the orchestration MCP config into the session's working
    // dir BEFORE the client attaches/spawns the agent, so the agent reads
    // spawn_worker on first launch. ensureMcpConfig also git-excludes the file
    // so it doesn't pollute the repo. Best-effort — never blocks session create.
    // Gated on the provider: `.mcp.json` is Claude's convention, so writing it
    // for Codex/Hermes would silently do nothing — the UI disables the box for
    // them, and this guard protects direct API callers too.
    if (
      enableOrchestration &&
      getProviderDefinition(agentType).supportsOrchestration
    ) {
      try {
        if (agentType === "codex") {
          // Codex has no on-disk project config; persist the per-launch
          // `-c mcp_servers.stoa.*` flags so the client replays them on every
          // spawn (session-scoped, nothing written to ~/.codex).
          queries
            .updateSessionMcpArgs(db)
            .run(JSON.stringify(buildCodexOrchestrationArgs(id)), id);
        } else if (agentType === "hermes") {
          // Hermes reads MCP servers only from its global config and strips env
          // vars from MCP children, so register the stoa server once (global,
          // idempotent) and drop this conductor's id in a cwd marker file.
          ensureHermesMcpRegistered();
          writeConductorMarker(expandHome(actualWorkingDirectory), id);
        } else {
          // Claude reads a project .mcp.json on launch.
          ensureMcpConfig(expandHome(actualWorkingDirectory), id);
        }
      } catch (err) {
        console.error("Failed to write orchestration MCP config:", err);
      }
    }

    // Get project's initial prompt if available
    const projectInitialPrompt = project?.initial_prompt?.trim();
    const sessionInitialPrompt = initialPrompt?.trim();

    // Combine prompts: project prompt first, then session prompt
    let combinedPrompt: string | undefined;
    if (projectInitialPrompt && sessionInitialPrompt) {
      combinedPrompt = `${projectInitialPrompt}\n\n${sessionInitialPrompt}`;
    } else if (projectInitialPrompt) {
      combinedPrompt = projectInitialPrompt;
    } else if (sessionInitialPrompt) {
      combinedPrompt = sessionInitialPrompt;
    }

    // Worktree sessions: prepend a boundary note so the agent edits inside the
    // worktree (its cwd) rather than reaching back to the base checkout via
    // absolute paths — the common cause of "changes don't show in the drawer".
    if (worktreePath) {
      const note =
        `[Stoa] You are working inside a git worktree at ${worktreePath}` +
        (branchName ? ` on branch "${branchName}"` : "") +
        `. Make ALL file edits inside this directory — do not edit the base ` +
        `checkout or any other branch.`;
      combinedPrompt = combinedPrompt ? `${note}\n\n${combinedPrompt}` : note;
    } else if (workspacePaths && workspacePaths.length > 0) {
      // Multi-repo workspace: tell the agent each subfolder is a separate repo's
      // worktree on its own branch — work per-repo, open a PR per repo, and that
      // each worktree is a FRESH checkout (no installed deps yet).
      const skipped =
        workspaceErrors.length > 0
          ? ` (skipped: ${workspaceErrors.map((e) => e.repoName).join(", ")})`
          : "";
      const note =
        `[Stoa] You are in a MULTI-REPO workspace at ${actualWorkingDirectory}. ` +
        `Each subfolder is a git worktree of a SEPARATE repo` +
        (workspaceBranch ? ` on branch "${workspaceBranch}"` : "") +
        `: ${workspaceRepoNames.join(", ")}${skipped}. cd into a repo's folder to ` +
        `work on it; commit and open a PR per repo. A change can't span two git ` +
        `repos — keep edits within each subfolder, and do NOT edit the original ` +
        `checkouts. Each worktree is a fresh checkout, so run that repo's install ` +
        `step (e.g. npm install) before building or testing it.`;
      combinedPrompt = combinedPrompt ? `${note}\n\n${combinedPrompt}` : note;
    }

    // Fleet memory (#9): if this session is in a tracked dispatch repo, append its
    // known pitfalls so interactive work benefits from the same memory as the
    // dispatched fleet. Match the REPO ROOT the user chose (workingDirectory), not
    // actualWorkingDirectory — a worktree session's actual cwd is the worktree, not
    // the repo_path. Best-effort; only rides along with an existing prompt.
    if (combinedPrompt) {
      combinedPrompt += getLessonsBlockForCwd(workingDirectory);
    }

    // Include setup result and initial prompt in response
    const response: {
      session: Session;
      setup?: SetupResult;
      initialPrompt?: string;
    } = { session };
    if (setupResult) {
      response.setup = setupResult;
    }
    if (combinedPrompt) {
      response.initialPrompt = combinedPrompt;
    }

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error("Error creating session:", error);
    return NextResponse.json(
      { error: "Failed to create session" },
      { status: 500 }
    );
  }
}
