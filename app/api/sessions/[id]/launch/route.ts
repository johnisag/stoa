import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { getBackendType, getSessionBackend } from "@/lib/session-backend";
import {
  buildAgentArgs,
  buildTmuxFlags,
  getProvider,
  shellQuoteArg,
} from "@/lib/providers";
import { backendKeyForSession } from "@/lib/providers/registry";
import {
  isGenericSessionLaunchAllowed,
  resolveSessionLaunchOptions,
  sessionLaunchEnv,
} from "@/lib/session-launch";
import {
  backendKeyOwners,
  genericSessionRouteFailure,
} from "@/lib/session-route-access";
import { parseJsonBody } from "@/lib/api-security";
import { validateAgentCommand, wrapWithBanner } from "@/lib/banner";
import { isSessionDeletionFenced } from "@/lib/session-deletion";

const INITIAL_PROMPT_MAX_LENGTH = 200_000;

/**
 * Ensure an ordinary interactive tmux session exists before the browser attaches.
 * Creation stays behind SessionBackend so old tmux releases use the backend's
 * set-environment/respawn compatibility path instead of receiving unsupported
 * `new-session -e` flags from a browser shell command.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const parsed = await parseJsonBody<{ initialPrompt?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const { initialPrompt } = parsed.data;
  if (
    initialPrompt !== undefined &&
    initialPrompt !== null &&
    typeof initialPrompt !== "string"
  ) {
    return NextResponse.json(
      { error: "initialPrompt must be a string" },
      { status: 400 }
    );
  }
  if (
    typeof initialPrompt === "string" &&
    initialPrompt.length > INITIAL_PROMPT_MAX_LENGTH
  ) {
    return NextResponse.json(
      { error: "initialPrompt exceeds maximum length" },
      { status: 400 }
    );
  }

  if (getBackendType() !== "tmux") {
    return NextResponse.json(
      {
        error: "Server-side tmux launch is unavailable for the active backend",
      },
      { status: 409 }
    );
  }

  const { id } = await params;
  const db = getDb();
  const session = queries.getSession(db).get(id) as Session | undefined;
  const accessFailure = genericSessionRouteFailure(session);
  if (accessFailure) {
    return NextResponse.json(
      { error: accessFailure.error },
      { status: accessFailure.status }
    );
  }
  if (isSessionDeletionFenced(db, id)) {
    return NextResponse.json(
      { error: "Session deletion is in progress" },
      { status: 409 }
    );
  }

  const sessions = queries.getAllSessions(db).all() as Session[];
  const sessionName = backendKeyForSession(session!);
  const owners = backendKeyOwners(sessions, sessionName);
  if (owners.length !== 1 || owners[0].id !== id) {
    return NextResponse.json(
      { error: "Session backend key is not uniquely owned" },
      { status: 409 }
    );
  }

  try {
    const backend = getSessionBackend();
    if (await backend.exists(sessionName)) {
      return NextResponse.json({
        success: true,
        created: false,
        sessionName,
      });
    }

    const prompt =
      typeof initialPrompt === "string"
        ? initialPrompt || undefined
        : undefined;
    const resolved = resolveSessionLaunchOptions(session!, {
      initialPrompt: prompt,
      // Match the browser's ordinary-session list: a corrupt parent pointer must
      // never let a generic launch inherit an internal session's provider state.
      allSessions: sessions.filter(isGenericSessionLaunchAllowed),
    });

    let command = "";
    let binary: string | undefined;
    let args: string[] | undefined;
    if (resolved) {
      const provider = getProvider(resolved.agentType);
      const extraArgs = resolved.options.extraArgs ?? [];
      const flags = buildTmuxFlags(
        provider.buildFlags(resolved.options),
        extraArgs.map(shellQuoteArg),
        !!resolved.options.initialPrompt?.trim()
      );
      const agentCommand = `${provider.command} ${flags.join(" ")}`;
      const validatedCommand = validateAgentCommand(agentCommand);
      if (!validatedCommand) {
        throw new Error("Failed to construct a safe session command");
      }
      try {
        command = wrapWithBanner(validatedCommand);
      } catch (error) {
        // Match the former browser path: a banner-file failure must not prevent
        // the otherwise valid agent command from launching.
        console.warn(
          "Failed to create session init script; launching directly:",
          error
        );
        command = validatedCommand;
      }
      ({ binary, args } = buildAgentArgs(resolved.agentType, resolved.options));
    }

    await backend.create({
      name: sessionName,
      cwd: session!.working_directory || "~",
      command,
      binary,
      args,
      env: sessionLaunchEnv(session!),
    });

    // The delete route publishes its durable fence before stopping a process.
    // Re-check after this asynchronous create to close the inverse ordering:
    // launch checked first, delete killed the old process, then launch recreated
    // it. A completed claim remains as a tombstone, so stale clients are fenced
    // even after the sessions row has gone.
    if (isSessionDeletionFenced(db, id)) {
      try {
        await backend.kill(sessionName);
      } catch (error) {
        console.error(
          `Failed to stop session ${sessionName} after a deletion race:`,
          error
        );
        return NextResponse.json(
          { error: "Session deletion cleanup failed" },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { error: "Session deletion is in progress" },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      created: true,
      sessionName,
    });
  } catch (error) {
    console.error("Error launching tmux session:", error);
    return NextResponse.json(
      { error: "Failed to launch tmux session" },
      { status: 500 }
    );
  }
}
