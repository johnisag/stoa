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

/** Require a non-empty string arg, else throw a clear error (handleToolCall's
 * catch turns it into an "Error: …" response). Prevents `String(undefined)` from
 * building a request to `/workers/undefined`. */
export function requireString(
  args: Record<string, unknown> | undefined,
  key: string
): string {
  const v = args?.[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${key} is required`);
  }
  return v;
}

/** Coerce a tool's `lines` arg to a bounded positive integer (defaults to 50). */
export function clampLines(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 10000);
}

/** Collapse a (possibly multi-line) value to a single trimmed line, truncated to
 * `max` chars — so a list of entries stays scannable and a stored newline can't
 * forge fake "- " list rows. Shared by memory_list and notes_list. */
export function oneLinePreview(value: string, max = 120): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
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
          `/api/orchestrate/workers/${encodeURIComponent(requireString(args, "workerId"))}?lines=${clampLines(args?.lines)}`
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
          `/api/orchestrate/workers/${encodeURIComponent(requireString(args, "workerId"))}`,
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
          `/api/orchestrate/workers/${encodeURIComponent(requireString(args, "workerId"))}`,
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
          `/api/orchestrate/workers/${encodeURIComponent(requireString(args, "workerId"))}${cleanup}`,
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

      case "memory_set": {
        const key = requireString(args, "key");
        const result = await apiCall("/api/memory", {
          method: "POST",
          // value may be an empty string (a deliberately-blank note), so pass it
          // through as-is rather than coercing/defaulting.
          body: JSON.stringify({ key, value: args?.value }),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: result.error
                ? `Error: ${result.error}`
                : `Saved memory "${key}".`,
            },
          ],
        };
      }

      case "memory_get": {
        const key = requireString(args, "key");
        const result = await apiCall(
          `/api/memory?key=${encodeURIComponent(key)}`
        );
        return {
          content: [
            {
              type: "text" as const,
              // A missing key is a 404 → { error: "not found" }; report it as
              // "(not set)" rather than an error, since "no value yet" is normal.
              text: result.entry
                ? `${key}: ${result.entry.value}`
                : `${key}: (not set)`,
            },
          ],
        };
      }

      case "memory_list": {
        const result = await apiCall("/api/memory");
        if (result.error) {
          return {
            content: [
              { type: "text" as const, text: `Error: ${result.error}` },
            ],
          };
        }
        const entries: { key: string; value: string }[] = result.entries || [];
        if (entries.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "Shared memory is empty." },
            ],
          };
        }
        // One-line preview per entry (a value may be long / multi-line, which
        // would otherwise break the "- key: value" list); read the full value
        // with memory_get.
        const list = entries
          .map((e) => `- ${e.key}: ${oneLinePreview(e.value)}`)
          .join("\n");
        return {
          content: [{ type: "text" as const, text: `Shared memory:\n${list}` }],
        };
      }

      case "memory_delete": {
        const key = requireString(args, "key");
        const result = await apiCall(
          `/api/memory?key=${encodeURIComponent(key)}`,
          { method: "DELETE" }
        );
        return {
          content: [
            {
              type: "text" as const,
              text: result.error
                ? `Error: ${result.error}`
                : result.removed
                  ? `Deleted memory "${key}".`
                  : `No memory entry "${key}" to delete.`,
            },
          ],
        };
      }

      case "notes_list": {
        const result = await apiCall("/api/notes");
        if (result.error) {
          return {
            content: [
              { type: "text" as const, text: `Error: ${result.error}` },
            ],
          };
        }
        const notes: { id: string; title: string; content: string }[] =
          result.notes || [];
        if (notes.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No notes yet." }],
          };
        }
        const list = notes
          .map(
            (n) =>
              `- ${n.id.slice(0, 8)}  ${n.title || "(untitled)"}: ${oneLinePreview(n.content, 100)}`
          )
          .join("\n");
        return {
          content: [{ type: "text" as const, text: `Notes:\n${list}` }],
        };
      }

      case "notes_get": {
        const id = requireString(args, "id");
        const result = await apiCall(`/api/notes/${encodeURIComponent(id)}`);
        if (!result.note) {
          return {
            content: [
              { type: "text" as const, text: `No note with id "${id}".` },
            ],
          };
        }
        const n = result.note;
        return {
          content: [
            {
              type: "text" as const,
              text: `# ${n.title || "(untitled)"}\n\n${n.content}`,
            },
          ],
        };
      }

      case "notes_write": {
        // With an id → update that note; without → create a new one.
        const id = typeof args?.id === "string" ? args.id : null;
        const result = id
          ? await apiCall(`/api/notes/${encodeURIComponent(id)}`, {
              method: "PATCH",
              body: JSON.stringify({
                title: args?.title,
                content: args?.content,
              }),
            })
          : await apiCall("/api/notes", {
              method: "POST",
              body: JSON.stringify({
                title: args?.title,
                content: args?.content,
              }),
            });
        if (result.error || !result.note) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${result.error || (id ? `no note with id "${id}"` : "failed to create note")}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: id
                ? `Updated note ${result.note.id}.`
                : `Created note ${result.note.id}.`,
            },
          ],
        };
      }

      case "notes_delete": {
        const id = requireString(args, "id");
        const result = await apiCall(`/api/notes/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: result.error
                ? `Error: ${result.error}`
                : result.removed
                  ? `Deleted note ${id}.`
                  : `No note with id "${id}" to delete.`,
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
