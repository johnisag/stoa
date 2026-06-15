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
import { SPAWNABLE_AGENTS, handleToolCall } from "./orchestration-tools";

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
              // Derive from the single source of truth (same as run_pipeline's
              // schema) so kilo/kimi aren't silently unreachable via MCP.
              enum: SPAWNABLE_AGENTS,
              description:
                "Which agent to run the worker as (default claude). Lets a conductor delegate to a different agent than itself.",
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

server.setRequestHandler(CallToolRequestSchema, handleToolCall);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Stoa Orchestration MCP Server started");
}

main().catch(console.error);
