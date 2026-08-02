import { NextRequest, NextResponse } from "next/server";
import { existsSync, realpathSync } from "fs";
import { randomUUID } from "crypto";
import { getDb, queries, type Session, type Group } from "@/lib/db";
import { isValidAgentType, type AgentType } from "@/lib/providers";
import { sessionKey, getProviderDefinition } from "@/lib/providers/registry";
import { resolveModelForAgent, isSafeModel } from "@/lib/model-catalog";
import {
  createWorktree,
  getMainRepoPath,
  isStoaWorktree,
  listWorktrees,
  normalizeWorktreePath,
} from "@/lib/worktrees";
import { createWorkspace } from "@/lib/multi-repo-worktree";
import { setupWorktree, type SetupResult } from "@/lib/env-setup";
import { findAvailablePort } from "@/lib/ports";
import { runInBackground } from "@/lib/async-operations";
import { getProject } from "@/lib/projects";
import {
  ensureProviderMcpConfig,
  buildCodexOrchestrationArgs,
  ensureHermesMcpRegistered,
  McpConfigConflictError,
  McpConfigSetupError,
} from "@/lib/mcp-config";
import { expandHome, homeDir, isWindows } from "@/lib/platform";
import { getLessonsBlockForCwd } from "@/lib/dispatch/lessons";
import { composeLaunchPrompt } from "@/lib/prompt-compose";
import { isGenericSessionLaunchAllowed } from "@/lib/session-launch";
import { resolvePlaybookParts } from "@/lib/playbooks-server";
import {
  parseJsonBody,
  resolveRealSandboxedPath,
  resolveRealSandboxedPathOrHome,
  getAllowedPathRoots,
  sanitizeGroupPath,
  sanitizeSessionName,
  SYSTEM_PROMPT_MAX_LENGTH,
} from "@/lib/api-security";

// GET /api/sessions - List all sessions and groups
export async function GET() {
  try {
    const db = getDb();
    const sessions = (queries.getAllSessions(db).all() as Session[]).filter(
      isGenericSessionLaunchAllowed
    );
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
async function resolveProjectPath(
  input: string,
  project: { working_directory: string } | null | undefined
): Promise<{ allowed: boolean; resolved: string }> {
  const resolved = expandHome(input);
  // A project-bound session is confined to that project's workspace. A
  // projectless session may sit in ANY already-registered root (other projects,
  // repos, dispatch repos, live sessions, Stoa-managed dirs) or under the user's
  // home — not home-only, which 403s the common "repo on D:\ / /opt" layout.
  if (project) {
    return resolveRealSandboxedPath(resolved, [
      expandHome(project.working_directory),
    ]);
  }
  return resolveRealSandboxedPathOrHome(resolved, getAllowedPathRoots());
}

type ExistingWorktreeResolution =
  | { ok: true; path: string; branch: string | null }
  | { ok: false; status: 400 | 403; error: string };

/** Resolve aliases/junctions before comparing repository or worktree paths. */
function canonicalPathIdentity(candidatePath: string): string | null {
  try {
    return normalizeWorktreePath(realpathSync(expandHome(candidatePath)));
  } catch {
    return null;
  }
}

/**
 * Resolve an existing Stoa worktree for an attach.
 *
 * Stoa creates worktrees under ~/.stoa/worktrees rather than inside the source
 * checkout, so the normal descendant sandbox cannot authorize this mode.
 * Require three independent ownership signals instead: the path is Stoa-managed,
 * Git says its common repository is exactly the selected repository, and that
 * repository currently registers the path as a live worktree. The registered
 * branch is authoritative; never trust client metadata.
 */
async function resolveExistingWorktreeAttach(
  input: unknown,
  repositoryRoot: string
): Promise<ExistingWorktreeResolution> {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.includes("\0")
  ) {
    return {
      ok: false,
      status: 400,
      error: "existingWorktreePath must be a valid path",
    };
  }

  try {
    const candidatePath = expandHome(input);
    if (!isStoaWorktree(candidatePath)) {
      return {
        ok: false,
        status: 403,
        error: "Worktree is not a Stoa-managed worktree for this repository",
      };
    }
    if (!existsSync(candidatePath)) {
      return {
        ok: false,
        status: 400,
        error: `Worktree no longer exists: ${input}`,
      };
    }

    const candidateMainRepoPath = await getMainRepoPath(candidatePath);
    const selectedMainRepoPath = await getMainRepoPath(repositoryRoot);
    const candidateRepository = candidateMainRepoPath
      ? canonicalPathIdentity(candidateMainRepoPath)
      : null;
    const selectedRepository = selectedMainRepoPath
      ? canonicalPathIdentity(selectedMainRepoPath)
      : null;
    if (
      !candidateRepository ||
      !selectedRepository ||
      candidateRepository !== selectedRepository
    ) {
      return {
        ok: false,
        status: 403,
        error: "Worktree is not a Stoa-managed worktree for this repository",
      };
    }

    const normalizedCandidate = normalizeWorktreePath(candidatePath);
    const registeredWorktrees = await listWorktrees(repositoryRoot);
    const registered = registeredWorktrees.find(
      (worktree) =>
        normalizeWorktreePath(worktree.path) === normalizedCandidate &&
        isStoaWorktree(worktree.path)
    );
    if (!registered) {
      return {
        ok: false,
        status: 403,
        error: "Worktree is not a Stoa-managed worktree for this repository",
      };
    }

    return {
      ok: true,
      path: registered.path,
      branch: registered.branch || null,
    };
  } catch {
    // Invalid platform paths and unexpected Git/path failures are client input
    // failures here, never reasons to attach an unverified directory.
    return {
      ok: false,
      status: 400,
      error: "existingWorktreePath must be a valid path",
    };
  }
}

function sessionWorktreePaths(session: Session): string[] {
  const candidates = [session.working_directory];
  if (session.worktree_path) candidates.push(session.worktree_path);
  if (session.worktree_paths) {
    try {
      const parsed: unknown = JSON.parse(session.worktree_paths);
      if (Array.isArray(parsed)) {
        candidates.push(
          ...parsed.filter(
            (value): value is string => typeof value === "string"
          )
        );
      }
    } catch {
      // A malformed legacy workspace list must not break session creation.
    }
  }
  return candidates;
}

/** The attach picker is advisory; enforce ownership again at the DB boundary. */
function isWorktreeIdentityAttached(
  db: ReturnType<typeof getDb>,
  identity: string
): boolean {
  const sessions = queries.getAllSessions(db).all() as Session[];
  return sessions.some((session) =>
    sessionWorktreePaths(session).some(
      (candidate) => canonicalPathIdentity(candidate) === identity
    )
  );
}

/** Serialize attach check + session insertion across concurrent request handlers. */
function immediateTransaction<T>(
  db: ReturnType<typeof getDb>,
  action: () => T
): T {
  if (db.inTransaction) return action();
  return db.transaction(action).immediate();
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
      // Multi-repo workspace: when the chosen root holds several git repos, the
      // picked ones ({ path, name }[]) each get a worktree under one workspace dir.
      workspaceRepos = null,
      // Tmux option
      useTmux = true,
      // Initial prompt to send when session starts
      initialPrompt = null,
      // Conductor: install the provider-native orchestration MCP wiring so this
      // session can spawn workers via the stoa MCP's spawn_worker tool.
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
    if (parentSessionId) {
      const parent = queries.getSession(db).get(parentSessionId) as
        Session | undefined;
      if (parent && !isGenericSessionLaunchAllowed(parent)) {
        return NextResponse.json(
          { error: "Internal sessions cannot be forked or resumed" },
          { status: 409 }
        );
      }
    }

    const hasExistingWorktreePath =
      existingWorktreePath !== null && existingWorktreePath !== undefined;
    const isExistingWorktreeAttach = useWorktree && hasExistingWorktreePath;
    // Uncategorized is the projectless bucket: its stored `~` is not the
    // repository the user selected in the dialog.
    const scopedProject = project?.is_uncategorized ? null : project;
    const isProjectWorktreeAttach =
      isExistingWorktreeAttach && Boolean(scopedProject);

    // A project-bound existing-worktree attach has its own stricter Git
    // ownership validation below. Its cwd lives under ~/.stoa/worktrees by
    // design, so use the trusted project root here instead of applying the
    // ordinary project-descendant check to a client-supplied worktree path.
    // All non-attach modes retain the normal workingDirectory validation.
    const cwdInput =
      isProjectWorktreeAttach && scopedProject
        ? scopedProject.working_directory
        : workingDirectory;
    if (typeof cwdInput !== "string" || cwdInput.includes("\0")) {
      return NextResponse.json(
        { error: "workingDirectory must be a valid path" },
        { status: 400 }
      );
    }
    const cwdCheck = await resolveProjectPath(cwdInput, scopedProject ?? null);
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
        const repoCheck = await resolveProjectPath(
          String(r.path),
          scopedProject ?? null
        );
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
    } else if (isExistingWorktreeAttach) {
      // Attach to an existing worktree: it's already on disk (with its files +
      // branch + installed deps), so skip createWorktree and setupWorktree —
      // just point the session at it and allocate a dev-server port.
      const repositoryRoot = scopedProject
        ? scopedProject.working_directory
        : cwdCheck.resolved;
      const resolved = await resolveExistingWorktreeAttach(
        existingWorktreePath,
        repositoryRoot
      );
      if (!resolved.ok) {
        return NextResponse.json(
          { error: resolved.error },
          { status: resolved.status }
        );
      }
      worktreePath = resolved.path;
      branchName = resolved.branch;
      actualWorkingDirectory = worktreePath;
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
    const insertSession = () => {
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

      if (worktreePath) {
        queries
          .updateSessionWorktree(db)
          .run(worktreePath, branchName, baseBranch, port, id);
      }
    };
    type InsertResult = "inserted" | "attached" | "missing";
    let insertResult: InsertResult;
    if (isExistingWorktreeAttach) {
      insertResult = immediateTransaction<InsertResult>(db, () => {
        if (!worktreePath) return "missing";
        const identity = canonicalPathIdentity(worktreePath);
        if (!identity) return "missing";
        if (isWorktreeIdentityAttached(db, identity)) return "attached";
        // Reserve the attached path in the same transaction as the session row.
        insertSession();
        return "inserted";
      });
    } else {
      // Preserve the existing transaction boundary for all non-attach flows.
      insertSession();
      insertResult = "inserted";
    }
    if (insertResult === "attached") {
      return NextResponse.json(
        { error: "Worktree is already attached to another session" },
        { status: 409 }
      );
    }
    if (insertResult === "missing") {
      return NextResponse.json(
        { error: `Worktree no longer exists: ${existingWorktreePath}` },
        { status: 400 }
      );
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

    // Conductor: install provider-native MCP wiring before the client attaches,
    // so spawn_worker is present on first launch. Project-config providers write
    // a locally git-excluded file; Codex persists per-launch argv and Hermes uses
    // its global registration. Each path receives this session's identity at
    // process launch. This remains best-effort so an unavailable CLI or
    // unwritable config cannot strand the session/worktree already created.
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
          // Hermes reads MCP servers from global config. The entry maps a
          // generic placeholder from this agent process into its MCP child.
          ensureHermesMcpRegistered();
          queries.updateSessionMcpArgs(db).run("[]", id);
        } else {
          // Claude, Kilo, and Kimi each read a different project config path and
          // schema. The dispatcher fails closed if this capability contract ever
          // advertises a provider without a writer.
          ensureProviderMcpConfig(
            agentType,
            expandHome(actualWorkingDirectory),
            id,
            {
              isLegacyClaudeSessionOwned: (
                legacySessionId,
                configWorkingDirectory
              ) => {
                const legacy = queries.getSession(db).get(legacySessionId) as
                  Session | undefined;
                return (
                  !!legacy &&
                  legacy.agent_type === "claude" &&
                  isGenericSessionLaunchAllowed(legacy) &&
                  legacy.mcp_launch_args !== null &&
                  normalizeWorktreePath(legacy.working_directory) ===
                    normalizeWorktreePath(configWorkingDirectory)
                );
              },
            }
          );
          // An empty argv list is an intentional persisted conductor sentinel:
          // launch paths use non-null mcp_launch_args to inject this session's
          // STOA_CONDUCTOR_SESSION_ID into the agent process.
          queries.updateSessionMcpArgs(db).run("[]", id);
        }
      } catch (err) {
        if (err instanceof McpConfigSetupError) {
          queries.deleteSession(db).run(id);
          return NextResponse.json({ error: err.message }, { status: 503 });
        }
        if (err instanceof McpConfigConflictError) {
          // Never leave a launchable session that could inherit another
          // conductor's MCP identity. The generated/attached worktree remains
          // recoverable; only the not-yet-launched session row is rolled back.
          queries.deleteSession(db).run(id);
          return NextResponse.json({ error: err.message }, { status: 409 });
        }
        console.error("Failed to write orchestration MCP config:", err);
      }
    }

    // Re-read after orchestration wiring so the response carries the persisted
    // conductor sentinel/argv used by the very first launch.
    const session = queries.getSession(db).get(id) as Session;

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
