/**
 * MCP Server for Session Orchestration
 *
 * Exposes tools for any Claude session to become a "conductor" that spawns
 * and manages worker sessions. Each worker gets its own git worktree.
 *
 * Stoa writes provider-native MCP config automatically. The generated command
 * uses `process.execPath` plus Stoa's absolute, pinned `tsx/dist/cli.mjs` path;
 * never launch this through project-local `npx`. A representative Claude entry:
 *   {
 *     "mcpServers": {
 *       "stoa": {
 *         "command": "/absolute/path/to/node",
 *         "args": ["/path/to/stoa/node_modules/tsx/dist/cli.mjs", "/path/to/stoa/mcp/orchestration-server.ts"],
 *         "env": {
 *           "STOA_URL": "http://localhost:3011",
 *           "CONDUCTOR_SESSION_ID": "${STOA_CONDUCTOR_SESSION_ID}"
 *         }
 *       }
 *     }
 *   }
 *
 * Usage: Any session can spawn workers by calling spawn_worker with its own
 * session ID as conductorId. The UI will show the conductor/worker hierarchy.
 */

import "../lib/als-global";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INVALID_PARAMS,
  ProtocolError,
  Server,
  type Tool,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  type ServeStdioOptions,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { SPAWNABLE_AGENTS, handleToolCall } from "./orchestration-tools";
import { emitGenAiEvent } from "../lib/telemetry/otel";

const fleetCapabilityProperties = {
  capabilityToken: {
    type: "string",
    description:
      "Opaque token returned once by the admin-only Fleet capability API.",
  },
  runId: {
    type: "string",
    description: "Exact capability-scoped Fleet run id.",
  },
  taskId: {
    type: "string",
    description:
      "Exact task scope when present; omit for an explicit null scope.",
  },
  workerId: {
    type: "string",
    description:
      "Exact worker scope when present; omit for an explicit null scope.",
  },
  attempt: {
    type: "integer",
    minimum: 1,
    description:
      "Exact attempt scope when present; omit for an explicit null scope.",
  },
  boundHashKind: {
    type: "string",
    enum: ["plan", "execution", "head", "artifact"],
  },
  boundHashValue: {
    type: "string",
    description: "Exact lowercase hash from the issued capability scope.",
  },
};

const fleetCapabilityRequired = [
  "capabilityToken",
  "runId",
  "boundHashKind",
  "boundHashValue",
];

const DIRECT_FLEET_MCP_TOOLS: Tool[] = [
  {
    name: "fleet_list_runs",
    description:
      "Read the bounded Fleet run snapshot using a reusable fleet:read capability with reserved run scope '*'.",
    inputSchema: {
      type: "object",
      properties: {
        capabilityToken: fleetCapabilityProperties.capabilityToken,
      },
      required: ["capabilityToken"],
      additionalProperties: false,
    },
  },
  {
    name: "fleet_get_run",
    description:
      "Read one Fleet run snapshot, including its tasks, workers, artifacts, verifications, and recent events.",
    inputSchema: {
      type: "object",
      properties: {
        capabilityToken: fleetCapabilityProperties.capabilityToken,
        runId: { type: "string" },
      },
      required: ["capabilityToken", "runId"],
      additionalProperties: false,
    },
  },
  {
    name: "fleet_list_tasks",
    description: "Read the current task snapshot for one Fleet run.",
    inputSchema: {
      type: "object",
      properties: {
        capabilityToken: fleetCapabilityProperties.capabilityToken,
        runId: { type: "string" },
      },
      required: ["capabilityToken", "runId"],
      additionalProperties: false,
    },
  },
  {
    name: "fleet_supervisor_snapshot",
    description:
      "Read the bounded, advisory Fleet supervisor snapshot for one exact run using a reusable fleet:read capability.",
    inputSchema: {
      type: "object",
      properties: {
        capabilityToken: fleetCapabilityProperties.capabilityToken,
        runId: { type: "string" },
      },
      required: ["capabilityToken", "runId"],
      additionalProperties: false,
    },
  },
  {
    name: "fleet_create_run",
    description:
      "Create the exact draft authorized by a fleet:create capability. MCP cannot issue this capability.",
    inputSchema: {
      type: "object",
      properties: {
        ...fleetCapabilityProperties,
        draft: {
          type: "object",
          description: "Exact bound draft-run payload.",
        },
      },
      required: [...fleetCapabilityRequired, "draft"],
      additionalProperties: false,
    },
  },
  {
    name: "fleet_plan_run",
    description:
      "Ingest an exact plan using a plan-hash-bound fleet:plan capability.",
    inputSchema: {
      type: "object",
      properties: {
        ...fleetCapabilityProperties,
        planText: { type: "string" },
      },
      required: [...fleetCapabilityRequired, "planText"],
      additionalProperties: false,
    },
  },
  {
    name: "fleet_approve_run",
    description:
      "Approve the exact reviewed plan using a separately human-issued fleet:approve capability. MCP elicitation never grants approval.",
    inputSchema: {
      type: "object",
      properties: fleetCapabilityProperties,
      required: fleetCapabilityRequired,
      additionalProperties: false,
    },
  },
  {
    name: "fleet_start_run",
    description:
      "Start an approved Fleet run using an execution-hash-bound fleet:start capability.",
    inputSchema: {
      type: "object",
      properties: fleetCapabilityProperties,
      required: fleetCapabilityRequired,
      additionalProperties: false,
    },
  },
  {
    name: "fleet_pause_run",
    description:
      "Pause new Fleet scheduling using an execution-hash-bound fleet:pause capability. It never kills workers.",
    inputSchema: {
      type: "object",
      properties: fleetCapabilityProperties,
      required: fleetCapabilityRequired,
      additionalProperties: false,
    },
  },
  {
    name: "fleet_resume_run",
    description:
      "Resume an approved Fleet run using an execution-hash-bound fleet:resume capability.",
    inputSchema: {
      type: "object",
      properties: fleetCapabilityProperties,
      required: fleetCapabilityRequired,
      additionalProperties: false,
    },
  },
  {
    name: "fleet_cancel_run",
    description:
      "Cancel a Fleet run while preserving worktrees, using an execution-hash-bound fleet:cancel capability.",
    inputSchema: {
      type: "object",
      properties: fleetCapabilityProperties,
      required: fleetCapabilityRequired,
      additionalProperties: false,
    },
  },
  {
    name: "fleet_submit_artifact",
    description:
      "Attach an exact plan-review artifact using an artifact-hash-bound capability.",
    inputSchema: {
      type: "object",
      properties: {
        ...fleetCapabilityProperties,
        artifact: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            severity: {
              type: "string",
              enum: ["info", "warning", "blocker"],
            },
            expectedPlanHash: { type: "string" },
          },
          required: ["title", "body", "expectedPlanHash"],
        },
      },
      required: [...fleetCapabilityRequired, "artifact"],
      additionalProperties: false,
    },
  },
  {
    name: "fleet_merge_run",
    description:
      "Request the exact target/head-bound merge authorized by a separately human-issued fleet:merge capability.",
    inputSchema: {
      type: "object",
      properties: {
        ...fleetCapabilityProperties,
        target: { type: "string", enum: ["local", "github_pr"] },
      },
      required: [...fleetCapabilityRequired, "target"],
      additionalProperties: false,
    },
  },
];

export function createOrchestrationServer(): Server {
  const server = new Server(
    {
      name: "stoa-orchestration",
      version: "2.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler("tools/list", async () => {
    const tools: Tool[] = [
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
      {
        name: "memory_set",
        description:
          "Write a key→value entry to the SHARED fleet memory — a scratchpad every Stoa agent session can read. Use it to coordinate across worktrees: the interface contract you chose, a column name, 'don't touch file X', a discovered gotcha. Overwrites an existing key.",
        inputSchema: {
          type: "object" as const,
          properties: {
            key: {
              type: "string",
              description:
                "A short label for the entry (e.g. 'db-schema-decision').",
            },
            value: {
              type: "string",
              description:
                "The note to store (read back later with memory_get).",
            },
          },
          required: ["key", "value"],
        },
      },
      {
        name: "memory_get",
        description:
          "Read one entry from the shared fleet memory by key. Returns the stored note, or '(not set)' if no agent has written that key.",
        inputSchema: {
          type: "object" as const,
          properties: {
            key: { type: "string", description: "The entry's key." },
          },
          required: ["key"],
        },
      },
      {
        name: "memory_list",
        description:
          "List the keys in the shared fleet memory (with a one-line preview of each note), most-recently-updated first. Use memory_get for a key's full value.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "memory_delete",
        description:
          "Delete a key from the shared fleet memory once it's no longer relevant.",
        inputSchema: {
          type: "object" as const,
          properties: {
            key: { type: "string", description: "The entry's key." },
          },
          required: ["key"],
        },
      },
      {
        name: "notes_list",
        description:
          "List the shared knowledge-base notes (id + title + a one-line preview), pinned first then most-recently-updated. Notes are longer markdown docs shared across the whole fleet — use them for handoffs, an interface contract, or anything worth reading later (vs the short key→value memory_* scratchpad). Use notes_get for a note's full body.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "notes_get",
        description:
          "Read one knowledge-base note's full markdown body by its id (from notes_list).",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: { type: "string", description: "The note's id." },
          },
          required: ["id"],
        },
      },
      {
        name: "notes_write",
        description:
          "Create a knowledge-base note, or update an existing one. Omit `id` to create a new note (returns its id); pass `id` to overwrite that note's title/content. Markdown is supported. (Pinning is a human-curation action done in the UI, not here.)",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: {
              type: "string",
              description: "The note id to update; omit to create a new note.",
            },
            title: { type: "string", description: "The note's title." },
            content: {
              type: "string",
              description: "The note's markdown body.",
            },
          },
        },
      },
      {
        name: "notes_delete",
        description: "Delete a knowledge-base note by its id.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: { type: "string", description: "The note's id." },
          },
          required: ["id"],
        },
      },
      {
        name: "channel_send",
        description:
          "Send a DIRECT 1:1 message to another agent's session by its session id. Use this to coordinate point-to-point with a sibling worker — e.g. tell the worker that owns the schema what column name you chose. The message lands in the recipient's inbox (read with channel_inbox); if the operator enabled push delivery it is also injected at the recipient's next turn boundary. Your own session is the sender. Distinct from memory_*/notes_* (shared, undirected) — this is addressed to one session.",
        inputSchema: {
          type: "object" as const,
          properties: {
            to: {
              type: "string",
              description:
                "The recipient's Stoa session id (e.g. from list_workers or a message they sent you). Must be an existing session.",
            },
            message: {
              type: "string",
              description: "The message body to send.",
            },
          },
          required: ["to", "message"],
        },
      },
      {
        name: "channel_inbox",
        description:
          "Read and CONSUME your unread direct messages from other agents (oldest first). Reading marks them read, so the next call only returns what's new — act on each message now (reply with channel_send if needed). Use channel_history to re-read a conversation without consuming it.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "channel_history",
        description:
          "Review the full conversation between you and one peer session (both directions, oldest first). NON-consuming — it doesn't change unread state. Use channel_inbox to pick up new messages.",
        inputSchema: {
          type: "object" as const,
          properties: {
            peer: {
              type: "string",
              description: "The other session's id.",
            },
          },
          required: ["peer"],
        },
      },
      {
        name: "schedule_create",
        description:
          'Schedule a prompt to be sent into a session on a cadence — for a nightly run, a periodic check-in, or a deferred follow-up ("re-run the tests in 1 hour"). At the due time the prompt is enqueued into the target session and delivered the moment it next goes idle. Defaults to YOUR OWN session unless you pass sessionId. Returns the schedule id (cancel with schedule_delete).',
        inputSchema: {
          type: "object" as const,
          properties: {
            prompt: {
              type: "string",
              description: "The prompt text to send when the schedule fires.",
            },
            recurrence: {
              type: "string",
              enum: ["once", "hourly", "daily", "weekly"],
              description:
                "How often to fire. Omit (or pass 'once') for a single run; the others repeat until you delete the schedule.",
            },
            runAt: {
              type: "string",
              description:
                "Optional ISO-8601 time for the first (or only) run, e.g. '2026-06-28T02:00:00Z'. Omit to fire as soon as due (a one-shot) or one interval from now (a recurring one).",
            },
            sessionId: {
              type: "string",
              description:
                "The session to send the prompt to. Defaults to your own session.",
            },
            name: {
              type: "string",
              description: "Optional short label for the schedule.",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "schedule_list",
        description:
          "List the scheduled prompts (id, target session, cadence, next run time, enabled). Use schedule_delete to cancel one.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "schedule_delete",
        description: "Cancel a scheduled prompt by its id.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: { type: "string", description: "The schedule's id." },
          },
          required: ["id"],
        },
      },
      {
        name: "request_operator_input",
        description:
          "Ask the human OPERATOR a structured question and BLOCK until they answer in Stoa's UI (MCP elicitation, #48). Use when a decision is genuinely the operator's to make and you can't safely pick a default — e.g. which deployment target, a missing secret's name, or a yes/no gate before a risky action. Describe a small form as a flat list of primitive fields; returns the operator's typed answers, or that they declined/cancelled. Don't use it for anything you can decide yourself.",
        inputSchema: {
          type: "object" as const,
          properties: {
            conductorId: {
              type: "string",
              description:
                "Your session ID. Required unless CONDUCTOR_SESSION_ID env var is set.",
            },
            message: {
              type: "string",
              description:
                "The question/context shown to the operator above the form.",
            },
            fields: {
              type: "array",
              description:
                "The form fields to collect (1–12). Each is a primitive input.",
              items: {
                type: "object",
                properties: {
                  key: {
                    type: "string",
                    description:
                      "Answer key / identifier (letters, digits, _ . - ).",
                  },
                  type: {
                    type: "string",
                    enum: ["string", "number", "boolean", "enum"],
                    description: "The field's primitive type.",
                  },
                  description: {
                    type: "string",
                    description: "Label / hint shown next to the input.",
                  },
                  enumValues: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "The allowed options — REQUIRED when type is 'enum'.",
                  },
                },
                required: ["key", "type"],
              },
            },
          },
          required: ["message", "fields"],
        },
      },
    ];
    return {
      tools: [
        ...tools,
        ...DIRECT_FLEET_MCP_TOOLS,
        {
          name: "fleet_get_capabilities",
          description:
            "Describe Stoa Fleet's negotiated MCP protocol/SDK boundary, durable-state fallback, optional extension support, and authorization model.",
          inputSchema: {
            type: "object" as const,
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: "fleet_request_action",
          description:
            "Queue an informational Fleet lifecycle request for an operator. This never reads Fleet state, approves a plan, launches an agent, or changes a run; the operator must review and execute it in Fleet Management.",
          inputSchema: {
            type: "object" as const,
            properties: {
              conductorId: { type: "string" },
              runId: { type: "string" },
              action: {
                type: "string",
                enum: ["plan", "approve", "start_or_resume", "pause", "cancel"],
              },
              expectedPlanHash: { type: "string" },
              message: { type: "string" },
            },
            required: ["runId", "action"],
          },
        },
      ],
    };
  });

  // Resolve the conductor ID for a tool call. The Stoa-baked id is authoritative;
  // an agent-supplied `conductorId` is only used when there's no baked id (some
  // agents pass their own provider session id, which would break the worker FK).

  // handleToolCall catches its OWN errors and RETURNS an "Error: …" text result
  // (it rarely throws), so a plain try/catch would tag almost every failed tool as
  // an OK span and under-report error rates. Read the result: an `isError` flag or
  // a leading "Error:" in the first text part means the call failed.
  function toolResultStatus(result: unknown): {
    code: 1 | 2;
    message?: string;
  } {
    const r = result as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    const firstText = r?.content?.[0]?.text;
    const failed =
      r?.isError === true ||
      (typeof firstText === "string" && firstText.startsWith("Error:"));
    return failed ? { code: 2, message: firstText } : { code: 1 };
  }

  // Wrap the tool handler with a GenAI "tool" span at the natural tool boundary.
  // No-op unless STOA_OTEL_ENDPOINT is set, and best-effort — the span emit can
  // never change the tool's result or throw (emitGenAiEvent swallows its errors).
  server.setRequestHandler("tools/call", async (request, context) => {
    const startMs = Date.now();
    const toolName = request.params.name;
    try {
      const result = await handleToolCall(request, {
        signal: context.mcpReq.signal,
      });
      const first = result.content[0];
      if (
        result.isError === true &&
        first?.type === "text" &&
        first.text.startsWith("Error: Unknown tool:")
      ) {
        throw new ProtocolError(
          INVALID_PARAMS,
          first.text.slice("Error: ".length)
        );
      }
      // The low-level Server API leaves SEP-2106 result projection to its
      // caller. All current tools are text-only, but using the SDK codec keeps
      // this boundary correct if structured output is introduced later.
      const projectedResult = server.projectCallToolResult(result, undefined);
      const status = toolResultStatus(result);
      void emitGenAiEvent({
        operation: "tool",
        // The conductor MCP surface runs under Claude Code (anthropic); the tool
        // itself is provider-agnostic, so system is the harness, tool is the name.
        provider: "claude",
        startMs,
        endMs: Date.now(),
        toolName,
        statusCode: status.code,
        statusMessage: status.message,
        extra: { "stoa.mcp.tool": toolName },
      });
      return projectedResult;
    } catch (error) {
      void emitGenAiEvent({
        operation: "tool",
        provider: "claude",
        startMs,
        endMs: Date.now(),
        toolName,
        statusCode: 2, // ERROR
        statusMessage: error instanceof Error ? error.message : "tool failed",
        extra: { "stoa.mcp.tool": toolName },
      });
      throw error;
    }
  });

  return server;
}

export function serveOrchestrationStdio(
  options: Omit<ServeStdioOptions, "legacy"> = {}
): StdioServerHandle {
  return serveStdio(() => createOrchestrationServer(), {
    ...options,
    legacy: "serve",
  });
}

// Start the server
async function main() {
  serveOrchestrationStdio({
    onerror: (error) => console.error("Stoa MCP transport error:", error),
  });
  console.error("Stoa Orchestration MCP Server started");
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch(console.error);
}
