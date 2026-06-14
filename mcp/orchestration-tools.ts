import {
  resolveConductorSessionId,
  pickConductorId,
} from "../lib/conductor-marker";
import { PROVIDER_IDS } from "../lib/providers/registry";

// Agents that can run a worker/step — the single source of truth shared with
// the server-side validateSpec (PROVIDER_IDS minus the non-spawnable "shell").
// Deriving the MCP schema enum here keeps the advertised set from drifting when
// a provider is added/removed.
export const SPAWNABLE_AGENTS = PROVIDER_IDS.filter(
  (id) => id !== "shell"
) as string[];

const STOA_URL = process.env.STOA_URL || "http://localhost:3011";

// Conductor session ID: from CONDUCTOR_SESSION_ID (Claude/Codex bake it into the
// MCP config env) or a `.stoa-conductor` marker in our cwd (Hermes, which strips
// env vars from MCP children). Can still be overridden per tool call.
const DEFAULT_CONDUCTOR_ID = resolveConductorSessionId(process.cwd());

async function apiCall(path: string, options?: RequestInit) {
  const url = `${STOA_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  return response.json();
}

function getConductorId(
  args: Record<string, unknown> | undefined
): string | null {
  return pickConductorId(
    args?.conductorId as string | undefined,
    DEFAULT_CONDUCTOR_ID
  );
}

export async function handleToolCall(request: {
  params: { name: string; arguments?: Record<string, unknown> };
}) {
  const { name } = request.params;
  const args = request.params.arguments;

  try {
    switch (name) {
      case "spawn_worker": {
        const conductorId = getConductorId(args);
        if (!conductorId) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: conductorId is required. Pass it as a parameter or set CONDUCTOR_SESSION_ID env var.",
              },
            ],
          };
        }
        const result = await apiCall("/api/orchestrate/spawn", {
          method: "POST",
          body: JSON.stringify({
            conductorSessionId: conductorId,
            task: args?.task,
            workingDirectory: args?.workingDirectory,
            branchName: args?.branchName,
            useWorktree: args?.useWorktree ?? true,
            agentType: args?.agentType || "claude",
            // Omit → the route's resolveModelForAgent picks the agent's default
            // (forcing "sonnet" would push an invalid model at codex/hermes).
            model: args?.model,
          }),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: result.error
                ? `Error: ${result.error}`
                : `Worker spawned successfully!\nID: ${result.session.id}\nName: ${result.session.name}\nWorktree: ${result.session.worktree_path || "none"}`,
            },
          ],
        };
      }

      case "list_workers": {
        const conductorId = getConductorId(args);
        if (!conductorId) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: conductorId is required. Pass it as a parameter or set CONDUCTOR_SESSION_ID env var.",
              },
            ],
          };
        }
        const result = await apiCall(
          `/api/orchestrate/workers?conductorId=${encodeURIComponent(conductorId)}`
        );
        if (result.error) {
          return {
            content: [
              { type: "text" as const, text: `Error: ${result.error}` },
            ],
          };
        }
        const workers = result.workers || [];
        if (workers.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "No workers spawned yet." },
            ],
          };
        }
        const list = workers
          .map(
            (w: {
              id: string;
              name: string;
              status: string;
              task: string;
              branchName: string | null;
            }) =>
              `- [${w.status.toUpperCase()}] ${w.name} (${w.id.slice(0, 8)})\n  Task: ${w.task}\n  Branch: ${w.branchName || "none"}`
          )
          .join("\n\n");
        return {
          content: [{ type: "text" as const, text: `Workers:\n\n${list}` }],
        };
      }

      case "get_worker_output": {
        const result = await apiCall(
          `/api/orchestrate/workers/${encodeURIComponent(String(args?.workerId))}?lines=${args?.lines || 50}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: result.error
                ? `Error: ${result.error}`
                : result.output || "(no output)",
            },
          ],
        };
      }

      case "send_to_worker": {
        const result = await apiCall(
          `/api/orchestrate/workers/${encodeURIComponent(String(args?.workerId))}`,
          {
            method: "POST",
            body: JSON.stringify({
              action: "send",
              message: args?.message,
            }),
          }
        );
        return {
          content: [
            {
              type: "text" as const,
              text: result.error
                ? `Error: ${result.error}`
                : "Message sent successfully.",
            },
          ],
        };
      }

      case "complete_worker": {
        const result = await apiCall(
          `/api/orchestrate/workers/${encodeURIComponent(String(args?.workerId))}`,
          {
            method: "POST",
            body: JSON.stringify({ action: "complete" }),
          }
        );
        return {
          content: [
            {
              type: "text" as const,
              text: result.error
                ? `Error: ${result.error}`
                : "Worker marked as completed.",
            },
          ],
        };
      }

      case "kill_worker": {
        const cleanup = args?.cleanupWorktree ? "?cleanup=true" : "";
        const result = await apiCall(
          `/api/orchestrate/workers/${encodeURIComponent(String(args?.workerId))}${cleanup}`,
          { method: "DELETE" }
        );
        return {
          content: [
            {
              type: "text" as const,
              text: result.error
                ? `Error: ${result.error}`
                : "Worker killed successfully.",
            },
          ],
        };
      }

      case "run_pipeline": {
        const conductorId = getConductorId(args);
        if (!conductorId) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: conductorId is required. Pass it as a parameter or set CONDUCTOR_SESSION_ID env var.",
              },
            ],
          };
        }
        const result = await apiCall("/api/pipelines", {
          method: "POST",
          body: JSON.stringify({
            conductorSessionId: conductorId,
            spec: args?.spec,
          }),
        });
        if (result.error) {
          return {
            content: [
              { type: "text" as const, text: `Error: ${result.error}` },
            ],
          };
        }
        const run = result.run;
        const stepList = Object.values(
          run.steps as Record<string, { id: string; status: string }>
        )
          .map((st) => `- ${st.id}: ${st.status}`)
          .join("\n");
        return {
          content: [
            {
              type: "text" as const,
              text: `Pipeline started!\nRun ID: ${run.id}\nStatus: ${run.status}\nSteps:\n${stepList}\n\nPoll with get_pipeline(runId: "${run.id}").`,
            },
          ],
        };
      }

      case "get_pipeline": {
        const result = await apiCall(
          `/api/pipelines/${encodeURIComponent(String(args?.runId))}`
        );
        if (result.error) {
          return {
            content: [
              { type: "text" as const, text: `Error: ${result.error}` },
            ],
          };
        }
        const run = result.run;
        const stepList = Object.values(
          run.steps as Record<
            string,
            {
              id: string;
              status: string;
              detail: string | null;
              sessionId: string | null;
            }
          >
        )
          .map(
            (st) =>
              `- ${st.id}: ${st.status}${st.sessionId ? ` [session ${st.sessionId.slice(0, 8)}]` : ""}${st.detail ? ` (${st.detail})` : ""}`
          )
          .join("\n");
        return {
          content: [
            {
              type: "text" as const,
              text: `Pipeline ${run.id}\nStatus: ${run.status}\nSteps:\n${stepList}`,
            },
          ],
        };
      }

      case "get_workers_summary": {
        const conductorId = getConductorId(args);
        if (!conductorId) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: conductorId is required. Pass it as a parameter or set CONDUCTOR_SESSION_ID env var.",
              },
            ],
          };
        }
        const result = await apiCall(
          `/api/orchestrate/workers?conductorId=${encodeURIComponent(conductorId)}&summary=true`
        );
        if (result.error) {
          return {
            content: [
              { type: "text" as const, text: `Error: ${result.error}` },
            ],
          };
        }
        const s = result.summary;
        return {
          content: [
            {
              type: "text" as const,
              text: `Workers Summary:\n- Total: ${s.total}\n- Pending: ${s.pending}\n- Running: ${s.running}\n- Waiting: ${s.waiting}\n- Completed: ${s.completed}\n- Failed: ${s.failed}`,
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        },
      ],
    };
  }
}
