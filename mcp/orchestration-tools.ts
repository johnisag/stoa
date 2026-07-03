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

// #48 MCP elicitation — the tool blocks, polling its pending request over HTTP
// while the operator answers in Stoa's UI. Bounded well under the store's TTL so
// a slow/absent operator can't hold the tool call (or the stdio pipe) forever.
const ELICIT_POLL_INTERVAL_MS = 2000;
const ELICIT_POLL_TIMEOUT_MS = 8 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ElicitPollResult {
  status: string;
  action: string | null;
  content: Record<string, unknown> | null;
}

async function pollElicit(id: string): Promise<ElicitPollResult> {
  const deadline = Date.now() + ELICIT_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // apiCall returns the parsed body regardless of HTTP status; a 404 body is
    // { status: "unknown" }, which is non-pending → we stop and report it.
    const res = (await apiCall(
      `/api/mcp/elicit/${encodeURIComponent(id)}`
    )) as ElicitPollResult;
    if (res?.status && res.status !== "pending") return res;
    await sleep(ELICIT_POLL_INTERVAL_MS);
  }
  return { status: "timeout", action: null, content: null };
}

/** Render an elicitation outcome as the tool's text result. Deliberately NEVER
 * prefixed with "Error:" — an operator decline/cancel/timeout is a normal
 * outcome, not a tool failure (see toolResultStatus in orchestration-server). */
export function formatElicitResult(r: ElicitPollResult): string {
  if (r.status === "answered") {
    if (r.action === "accept" && r.content) {
      const lines = Object.entries(r.content).map(
        ([k, v]) => `- ${k}: ${String(v)}`
      );
      return `Operator provided input:\n${lines.join("\n")}`;
    }
    if (r.action === "decline") return "Operator declined to provide input.";
    return "Operator cancelled the request.";
  }
  if (r.status === "expired")
    return "The operator-input request expired with no answer.";
  if (r.status === "timeout")
    return "Timed out waiting for operator input (no answer).";
  return "The operator-input request is no longer available (treated as cancelled).";
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

      case "channel_send": {
        // The sender is THIS session (its own Stoa id), resolved the same way as
        // the conductor id; `to` is an arg.
        const from = getConductorId(args);
        if (!from) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: can't determine your own session id (set CONDUCTOR_SESSION_ID or run inside a Stoa session).",
              },
            ],
          };
        }
        const to = requireString(args, "to");
        const message = requireString(args, "message");
        const result = await apiCall("/api/channels", {
          method: "POST",
          body: JSON.stringify({ from, to, body: message }),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: result.error
                ? `Error: ${result.error}`
                : `Message sent to ${to.slice(0, 8)}.`,
            },
          ],
        };
      }

      case "channel_inbox": {
        const session = getConductorId(args);
        if (!session) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: can't determine your own session id (set CONDUCTOR_SESSION_ID or run inside a Stoa session).",
              },
            ],
          };
        }
        // PATCH consumes: returns the unread messages AND marks them read.
        const result = await apiCall("/api/channels", {
          method: "PATCH",
          body: JSON.stringify({ session }),
        });
        if (result.error) {
          return {
            content: [
              { type: "text" as const, text: `Error: ${result.error}` },
            ],
          };
        }
        const messages: {
          from_session_id: string;
          body: string;
          created_at: string;
        }[] = result.messages || [];
        if (messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        // Full bodies (the agent must act on each), and the FULL sender id on each
        // — an agent replies with channel_send(to: <that id>), so the id has to be
        // the complete session id, not a shortened prefix.
        const list = messages
          .map(
            (m) => `From ${m.from_session_id} (${m.created_at} UTC):\n${m.body}`
          )
          .join("\n\n---\n\n");
        return {
          content: [
            {
              type: "text" as const,
              text: `You have ${messages.length} new message(s). Reply with channel_send(to: the sender id shown on each).\n\n${list}`,
            },
          ],
        };
      }

      case "channel_history": {
        const session = getConductorId(args);
        if (!session) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: can't determine your own session id (set CONDUCTOR_SESSION_ID or run inside a Stoa session).",
              },
            ],
          };
        }
        const peer = requireString(args, "peer");
        const result = await apiCall(
          `/api/channels?session=${encodeURIComponent(session)}&peer=${encodeURIComponent(peer)}`
        );
        if (result.error) {
          return {
            content: [
              { type: "text" as const, text: `Error: ${result.error}` },
            ],
          };
        }
        const messages: { from_session_id: string; body: string }[] =
          result.messages || [];
        if (messages.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No messages with ${peer.slice(0, 8)} yet.`,
              },
            ],
          };
        }
        // Scannable one-line-per-message overview (use channel_inbox for full,
        // actionable bodies of NEW messages).
        const list = messages
          .map(
            (m) =>
              `- ${m.from_session_id === session ? "you" : m.from_session_id.slice(0, 8)}: ${oneLinePreview(m.body, 160)}`
          )
          .join("\n");
        return {
          content: [
            {
              type: "text" as const,
              text: `Conversation with ${peer.slice(0, 8)}:\n${list}`,
            },
          ],
        };
      }

      case "schedule_create": {
        // Default the target to the caller's own session ("schedule for myself").
        const sessionId =
          typeof args?.sessionId === "string" && args.sessionId.trim()
            ? args.sessionId
            : getConductorId(args);
        if (!sessionId) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: no target session — pass sessionId, or run inside a Stoa session (CONDUCTOR_SESSION_ID).",
              },
            ],
          };
        }
        const prompt = requireString(args, "prompt");
        const result = await apiCall("/api/schedules", {
          method: "POST",
          body: JSON.stringify({
            sessionId,
            prompt,
            recurrence: args?.recurrence,
            runAt: args?.runAt,
            name: args?.name,
          }),
        });
        if (result.error || !result.schedule) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${result.error || "failed to create schedule"}`,
              },
            ],
          };
        }
        const s = result.schedule;
        const cadence = s.recurrence ? `repeats ${s.recurrence}` : "once";
        return {
          content: [
            {
              type: "text" as const,
              text: `Scheduled (${cadence}) — next run ${s.next_run_at}. id: ${s.id}`,
            },
          ],
        };
      }

      case "schedule_list": {
        const result = await apiCall("/api/schedules");
        if (result.error) {
          return {
            content: [
              { type: "text" as const, text: `Error: ${result.error}` },
            ],
          };
        }
        const schedules: {
          id: string;
          name: string;
          session_id: string;
          prompt: string;
          recurrence: string | null;
          next_run_at: string;
          enabled: number;
        }[] = result.schedules || [];
        if (schedules.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No schedules." }],
          };
        }
        // The FULL id (not a prefix) — an agent cancels with schedule_delete(id),
        // which needs the complete id. Include the label when one was set.
        const list = schedules
          .map((s) => {
            const label = s.name ? ` "${s.name}"` : "";
            const cadence = s.enabled ? s.recurrence || "once" : "paused";
            return `- ${s.id}${label} [${cadence}] → ${s.session_id.slice(0, 8)} @ ${s.next_run_at}: ${oneLinePreview(s.prompt, 80)}`;
          })
          .join("\n");
        return {
          content: [{ type: "text" as const, text: `Schedules:\n${list}` }],
        };
      }

      case "schedule_delete": {
        const id = requireString(args, "id");
        const result = await apiCall(
          `/api/schedules/${encodeURIComponent(id)}`,
          { method: "DELETE" }
        );
        return {
          content: [
            {
              type: "text" as const,
              text: result.error
                ? `Error: ${result.error}`
                : result.removed
                  ? `Deleted schedule ${id}.`
                  : `No schedule with id "${id}" to delete.`,
            },
          ],
        };
      }

      case "request_operator_input": {
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
        // requireString throws on a missing message → caught below as an Error.
        const message = requireString(args, "message");
        const created = await apiCall("/api/mcp/elicit", {
          method: "POST",
          body: JSON.stringify({
            conductorId,
            message,
            fields: args?.fields,
          }),
        });
        if (created?.error || !created?.elicitationId) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${created?.error ?? "could not create the operator-input request"}`,
              },
            ],
          };
        }
        // Block until the operator answers, the request expires, or we time out.
        const result = await pollElicit(created.elicitationId);
        return {
          content: [
            { type: "text" as const, text: formatElicitResult(result) },
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
