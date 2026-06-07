#!/usr/bin/env npx ts-node
/**
 * MCP Server for Session Orchestration
 *
 * Exposes tools for any Claude session to become a "conductor" that spawns
 * and manages worker sessions. Each worker gets its own git worktree.
 *
 * Setup (one-time, in ~/.claude/settings.json or project .mcp.json):
 *   {
 *     "mcpServers": {
 *       "stoa": {
 *         "command": "npx",
 *         "args": ["tsx", "/path/to/stoa/mcp/orchestration-server.ts"],
 *         "env": {
 *           "STOA_URL": "http://localhost:3011"
 *         }
 *       }
 *     }
 *   }
 *
 * Usage: Any session can spawn workers by calling spawn_worker with its own
 * session ID as conductorId. The UI will show the conductor/worker hierarchy.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  resolveConductorSessionId,
  pickConductorId,
} from "../lib/conductor-marker";
import { PROVIDER_IDS } from "../lib/providers/registry";

// Agents that can run a worker/step — the single source of truth shared with
// the server-side validateSpec (PROVIDER_IDS minus the non-spawnable "shell").
// Deriving the MCP schema enum here keeps the advertised set from drifting when
// a provider is added/removed.
const SPAWNABLE_AGENTS = PROVIDER_IDS.filter(
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

const server = new Server(
  {
    name: "stoa-orchestration",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "spawn_worker",
        description:
          "Spawn a new worker session to handle a task. Creates an isolated git worktree for the worker.",
        inputSchema: {
          type: "object" as const,
          properties: {
            conductorId: {
              type: "string",
              description:
                "Your session ID (the conductor). Required unless CONDUCTOR_SESSION_ID env var is set.",
            },
            task: {
              type: "string",
              description: "The task/prompt to send to the worker",
            },
            workingDirectory: {
              type: "string",
              description:
                "The git repository path for the worker to operate in",
            },
            branchName: {
              type: "string",
              description:
                "Optional branch name for the worktree (auto-generated if not provided)",
            },
            useWorktree: {
              type: "boolean",
              description:
                "Whether to create an isolated worktree (default: true)",
              default: true,
            },
            agentType: {
              type: "string",
              enum: ["claude", "codex", "hermes"],
              description:
                "Which agent to run the worker as: claude (default), codex, or hermes. Lets a conductor delegate to a different agent than itself.",
              default: "claude",
            },
            model: {
              type: "string",
              description:
                "Optional model for the worker — agent-specific (e.g. a Claude model, or a 'provider/model' string for hermes). Omit for the agent's own default.",
            },
          },
          required: ["task", "workingDirectory"],
        },
      },
      {
        name: "list_workers",
        description: "List all worker sessions spawned by a conductor",
        inputSchema: {
          type: "object" as const,
          properties: {
            conductorId: {
              type: "string",
              description:
                "The conductor session ID. Required unless CONDUCTOR_SESSION_ID env var is set.",
            },
          },
        },
      },
      {
        name: "get_worker_output",
        description: "Get recent terminal output from a worker",
        inputSchema: {
          type: "object" as const,
          properties: {
            workerId: {
              type: "string",
              description: "The worker session ID",
            },
            lines: {
              type: "number",
              description: "Number of lines to retrieve (default: 50)",
              default: 50,
            },
          },
          required: ["workerId"],
        },
      },
      {
        name: "send_to_worker",
        description: "Send a message or command to a worker",
        inputSchema: {
          type: "object" as const,
          properties: {
            workerId: {
              type: "string",
              description: "The worker session ID",
            },
            message: {
              type: "string",
              description: "The message to send",
            },
          },
          required: ["workerId", "message"],
        },
      },
      {
        name: "complete_worker",
        description: "Mark a worker as completed (task finished successfully)",
        inputSchema: {
          type: "object" as const,
          properties: {
            workerId: {
              type: "string",
              description: "The worker session ID",
            },
          },
          required: ["workerId"],
        },
      },
      {
        name: "kill_worker",
        description:
          "Kill a worker session and optionally clean up its worktree",
        inputSchema: {
          type: "object" as const,
          properties: {
            workerId: {
              type: "string",
              description: "The worker session ID",
            },
            cleanupWorktree: {
              type: "boolean",
              description: "Whether to delete the worktree (default: false)",
              default: false,
            },
          },
          required: ["workerId"],
        },
      },
      {
        name: "run_pipeline",
        description:
          "Run a declarative multi-step agent pipeline (a DAG). Each step runs a task on a chosen agent and may depend on other steps; independent steps run in parallel (bounded), a failed step skips its dependents. NOTE: dependsOn controls ORDERING only — it does NOT pass a prior step's output into a dependent step, so encode any needed context in each step's task text. Returns a runId to poll with get_pipeline.",
        inputSchema: {
          type: "object" as const,
          properties: {
            conductorId: {
              type: "string",
              description:
                "Your session ID (the conductor). Required unless CONDUCTOR_SESSION_ID env var is set.",
            },
            spec: {
              type: "object",
              description:
                "The pipeline spec: { name, workingDirectory, steps: [{ id, agent, task, dependsOn?, model?, workingDirectory? }] }. dependsOn is a list of step ids that must succeed first (omit/empty = a root step that runs immediately).",
              properties: {
                name: { type: "string" },
                workingDirectory: {
                  type: "string",
                  description: "Default git repo path for steps.",
                },
                steps: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      agent: { type: "string", enum: SPAWNABLE_AGENTS },
                      task: { type: "string" },
                      dependsOn: { type: "array", items: { type: "string" } },
                      model: { type: "string" },
                      workingDirectory: { type: "string" },
                    },
                    required: ["id", "agent", "task"],
                  },
                },
              },
              required: ["name", "workingDirectory", "steps"],
            },
          },
          required: ["spec"],
        },
      },
      {
        name: "get_pipeline",
        description:
          "Poll a pipeline run's live state (per-step status + overall status) by its runId.",
        inputSchema: {
          type: "object" as const,
          properties: {
            runId: { type: "string", description: "The pipeline run ID." },
          },
          required: ["runId"],
        },
      },
      {
        name: "get_workers_summary",
        description: "Get a summary count of workers by status",
        inputSchema: {
          type: "object" as const,
          properties: {
            conductorId: {
              type: "string",
              description:
                "The conductor session ID. Required unless CONDUCTOR_SESSION_ID env var is set.",
            },
          },
        },
      },
    ],
  };
});

// Resolve the conductor ID for a tool call. The Stoa-baked id is authoritative;
// an agent-supplied `conductorId` is only used when there's no baked id (some
// agents pass their own provider session id, which would break the worker FK).
function getConductorId(
  args: Record<string, unknown> | undefined
): string | null {
  return pickConductorId(
    args?.conductorId as string | undefined,
    DEFAULT_CONDUCTOR_ID
  );
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

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
          `/api/orchestrate/workers?conductorId=${conductorId}`
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
          `/api/orchestrate/workers/${args?.workerId}?lines=${args?.lines || 50}`
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
          `/api/orchestrate/workers/${args?.workerId}`,
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
          `/api/orchestrate/workers/${args?.workerId}`,
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
          `/api/orchestrate/workers/${args?.workerId}${cleanup}`,
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
          `/api/orchestrate/workers?conductorId=${conductorId}&summary=true`
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
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Stoa Orchestration MCP Server started");
}

main().catch(console.error);
