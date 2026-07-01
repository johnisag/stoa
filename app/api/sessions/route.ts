import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { getDb, queries, type Session, type Group } from "@/lib/db";
import { isValidAgentType, type AgentType } from "@/lib/providers";
import { sessionKey, getProviderDefinition } from "@/lib/providers/registry";
import { resolveModelForAgent, isSafeModel } from "@/lib/model-catalog";
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
import { expandHome, homeDir, isWindows } from "@/lib/platform";
import { getLessonsBlockForCwd } from "@/lib/dispatch/lessons";
import { composeLaunchPrompt } from "@/lib/prompt-compose";
import { resolvePlaybookParts } from "@/lib/playbooks-server";
import {
  parseJsonBody,
  resolveSandboxedPath,
  resolveSandboxedPathOrHome,
  getAllowedPathRoots,
  sanitizeGroupPath,
  sanitizeSessionName,
  SYSTEM_PROMPT_MAX_LENGTH,
} from "@/lib/api-security";

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

    // Path context for client-side canonicalization (worktree-conflict detector):
    // the server knows the home dir + OS case-sensitivity; the browser doesn't.
    return NextResponse.json({
      sessions,
      groups: formattedGroups,
      homeDir: homeDir(),
      isWindows,
    });
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

/**
 * Validate that a session path resolves inside the project's workspace.
 * Returns the resolved absolute path on success, or null if it escapes.
 */
function resolveProjectPath(
  input: string,
  project: { working_directory: string } | null | undefined
): { allowed: boolean; resolved: string } {
  const resolved = expandHome(input);
  // A project-bound session is confined to that project's workspace. A
  // projectless session may sit in ANY already-registered root (other projects,
  // repos, dispatch repos, live sessions, Stoa-managed dirs) or under the user's
  // home — not home-only, which 403s the common "repo on D:\ / /opt" layout.
  if (project) {
    return resolveSandboxedPath(resolved, [
      expandHome(project.working_directory),
    ]);
  }
  return resolveSandboxedPathOrHome(resolved, getAllowedPathRoots());
}

// POST /api/sessions - Create new session
export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody<{
    name?: string;
    workingDirectory?: string;
    parentSessionId?: string;
    model?: string;
    systemPrompt?: string;
    groupPath?: string;
    claudeSessionId?: string;
    agentType?: string;
    autoApprove?: boolean;
    projectId?: string;
    useWorktree?: boolean;
    featureName?: string;
    baseBranch?: string;
    existingWorktreePath?: string;
    existingWorktreeBranch?: string;
    workspaceRepos?: Array<{ path: string; name: string }>;
    useTmux?: boolean;
    initialPrompt?: string;
    enableOrchestration?: boolean;
    playbookId?: string;
    budgetUsd?: number | null;
  }>(request);
  if (!parsed.ok) return parsed.response;

  try {
    const body = parsed.data;
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
      // Playbook (#13): a selected recipe whose body seeds the prompt (the dialog
      // inlines the body into initialPrompt instead; this is for API/Command callers).
      playbookId = null,
      // #21: a lifetime USD budget cap (80/100% alerts + opt-in park at cap).
      budgetUsd = null,
    } = body;

    // Validate agent type
    const agentType: AgentType = isValidAgentType(rawAgentType)
      ? rawAgentType
      : "claude";
    const project = projectId ? getProject(projectId) : null;
    if (projectId && !project) {
      return NextResponse.json({ error: "Project not found" }, { status: 400 });
    }

    // workingDirectory must resolve inside the project's workspace.
    const cwdCheck = resolveProjectPath(workingDirectory, project ?? null);
    if (!cwdCheck.allowed) {
      return NextResponse.json(
        { error: "workingDirectory is outside the project workspace" },
        { status: 403 }
      );
    }
    if (!existsSync(cwdCheck.resolved)) {
      return NextResponse.json(
        { error: `workingDirectory does not exist: ${workingDirectory}` },
        { status: 400 }
      );
    }

    const model = resolveModelForAgent(
      agentType,
      (typeof requestedModel === "string" && requestedModel.trim()) ||
        project?.default_model
    );

    // Clamp at the write boundary: a free-text-agent model is passed through
    // verbatim and rides into the spawn. Reject a non-empty, shell-unsafe model
    // (an empty/default model is fine — the agent uses its own default).
    if (model && !isSafeModel(model)) {
      return NextResponse.json(
        { error: `Invalid model: ${model}` },
        { status: 400 }
      );
    }

    // Sanitize name / groupPath and bound system prompt length.
    const name =
      sanitizeSessionName(providedName) ||
      (featureName ? featureName : generateSessionName(db));
    const sanitizedGroupPath = sanitizeGroupPath(groupPath) || "sessions";
    if (
      typeof systemPrompt === "string" &&
      systemPrompt.length > SYSTEM_PROMPT_MAX_LENGTH
    ) {
      return NextResponse.json(
        { error: "systemPrompt exceeds maximum length" },
        { status: 400 }
      );
    }

    const id = randomUUID();

    // Handle worktree creation if requested
    let worktreePath: string | null = null;
    let branchName: string | null = null;
    let actualWorkingDirectory = cwdCheck.resolved;
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
      // Validate each picked repo path is inside the project workspace.
      for (const r of workspaceRepos) {
        const repoCheck = resolveProjectPath(String(r.path), project ?? null);
        if (!repoCheck.allowed) {
          return NextResponse.json(
            {
              error: `workspace repo path is outside the project workspace: ${r.path}`,
            },
            { status: 403 }
          );
        }
      }
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
      // Only attach to an actual Stoa worktree that is ALSO inside the project's
      // workspace. Being a Stoa worktree is not enough on its own — a worktree
      // created for a different project or in an arbitrary location must not be
      // attachable here.
      const attachCheck = resolveProjectPath(
        existingWorktreePath,
        project ?? null
      );
      if (!attachCheck.allowed || !isStoaWorktree(attachPath)) {
        return NextResponse.json(
          {
            error:
              "Worktree is outside the allowed workspace or not a Stoa worktree",
          },
          { status: 403 }
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
        // #14b: the project's configured startup commands (build/codegen/…),
        // run safe-exec'd after deps install. Fetched here (setupWorktree is
        // deliberately DB-free) and captured for the background task.
        const capturedStartupCommands = (
          queries.getProjectStartupCommands(db).all(projectId) as Array<{
            name: string;
            command: string;
          }>
        ).map((c) => ({ name: c.name, command: c.command }));
        runInBackground(async () => {
          const result = await setupWorktree({
            worktreePath: capturedWorktreePath,
            sourcePath: capturedSourcePath,
            port: capturedPort,
            startupCommands: capturedStartupCommands,
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
      sanitizedGroupPath,
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

    // #21: a per-session budget cap. Fail-closed validation — only a finite
    // positive number is stored; anything else means "no budget".
    if (
      budgetUsd != null &&
      typeof budgetUsd === "number" &&
      Number.isFinite(budgetUsd) &&
      budgetUsd > 0
    ) {
      queries.setSessionBudget(db).run(budgetUsd, id);
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

    // Cache-aware launch (#12): the worktree/workspace boundary NOTE is SPLIT — its
    // stable, path-free instruction leads (so the agent still edits inside its cwd,
    // not the base checkout — the "changes don't show in the drawer" fix), while the
    // VOLATILE worktree path/branch trails as an annotation. Previously the unique
    // worktree path sat at byte 0, so no two sessions ever shared a cacheable prefix.
    let leadInstruction: string | undefined;
    let volatileSuffix: string | undefined;
    if (worktreePath) {
      leadInstruction =
        `[Stoa] You are working inside a git worktree — make ALL file edits inside ` +
        `your current directory (its cwd), not the base checkout or any other branch.`;
      volatileSuffix =
        `[Stoa] Worktree: ${worktreePath}` +
        (branchName ? ` · branch "${branchName}"` : "");
    } else if (workspacePaths && workspacePaths.length > 0) {
      const skipped =
        workspaceErrors.length > 0
          ? ` (skipped: ${workspaceErrors.map((e) => e.repoName).join(", ")})`
          : "";
      leadInstruction =
        `[Stoa] You are in a MULTI-REPO workspace: each subfolder is a git worktree ` +
        `of a SEPARATE repo. cd into a repo's folder to work on it; commit and open ` +
        `a PR per repo. A change can't span two git repos — keep edits within each ` +
        `subfolder, and do NOT edit the original checkouts. Each worktree is a fresh ` +
        `checkout, so run that repo's install step (e.g. npm install) before ` +
        `building or testing it.`;
      volatileSuffix =
        `[Stoa] Workspace: ${actualWorkingDirectory} · repos: ` +
        `${workspaceRepoNames.join(", ")}${skipped}` +
        (workspaceBranch ? ` · branch "${workspaceBranch}"` : "");
    }

    // Playbooks + auto-recalled knowledge (#13). Pinned project playbooks auto-prepend
    // (a stable per-project block); a selected recipe (playbookId) seeds the prompt.
    const { pinnedKnowledge, playbook: playbookBody } = resolvePlaybookParts(
      db,
      projectId,
      playbookId
    );

    // Fleet memory (#9): append this repo's known pitfalls, but only when there's
    // already a prompt to ride along with (mirrors the prior behavior). Match the
    // REPO ROOT the user chose (workingDirectory), not the worktree cwd.
    const hasPromptContent =
      !!leadInstruction ||
      !!projectInitialPrompt ||
      !!sessionInitialPrompt ||
      !!pinnedKnowledge ||
      !!playbookBody;
    const lessons = hasPromptContent
      ? getLessonsBlockForCwd(workingDirectory)
      : "";

    const combinedPrompt = composeLaunchPrompt({
      leadInstruction,
      pinnedKnowledge,
      playbook: playbookBody,
      projectPrompt: projectInitialPrompt,
      sessionPrompt: sessionInitialPrompt,
      lessons,
      volatileSuffix,
    });

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
