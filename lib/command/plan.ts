/**
 * Command Stoa — the planner prompt (pure) and the reply parser (pure).
 *
 * The chatbox sends the user's message to an agent that may either ANSWER a
 * question (plain prose, exactly like Phase 1 "Ask Stoa") or PROPOSE one of the
 * allowlisted actions (a single strict-JSON object). This module builds that
 * prompt and parses the reply back into a discriminated result. Both halves are
 * pure → unit-tested; the actual validation of a proposal lives in
 * lib/command/actions.ts (fail-closed allowlist), and the spawn lives in
 * lib/ask.ts (reused). Parsing is CONSERVATIVE and fail-safe: anything that isn't
 * unmistakably a `{"kind":"proposal", ...}` object degrades to an answer, so a
 * prose reply can never be mistaken for an action.
 */

import { sanitizeDigest } from "@/lib/summarize";

/** A project the planner may target (the agent picks an id from this list; the
 * executor derives the directory from it server-side — the agent never supplies a
 * path). */
export interface CommandProject {
  id: string;
  name: string;
  directory: string;
  agentType: string;
}

export interface CommandPromptInput {
  context: string;
  projects: CommandProject[];
  history?: { role: "user" | "assistant"; content: string }[];
  message: string;
}

const COMMAND_PREAMBLE = [
  "You are Stoa's built-in assistant. You can do two things:",
  "",
  "1. ANSWER a question about the user's fleet using ONLY the CONTEXT below —",
  "   reply in plain, concise prose (markdown is fine). Do this for anything that",
  "   is a question or isn't one of the supported ACTIONS.",
  "",
  "2. PROPOSE an action when the user clearly asks you to perform one. To propose,",
  "   reply with ONLY a single JSON object and NOTHING else (no prose, no code",
  "   fences). Supported actions:",
  "",
  "   - create_session: start a new agent session. Shape:",
  '     {"kind":"proposal","action":"create_session","params":{',
  '       "projectId":"<an id from PROJECTS below — never invent a path>",',
  '       "agentType":"claude" | "codex" | "hermes",',
  '       "model":"<optional model alias, e.g. opus>",',
  '       "name":"<optional short session title>"}}',
  "",
  "Rules: only propose create_session when the user clearly wants to start/open/",
  "create a new session or agent. Choose projectId ONLY from the PROJECTS list. If",
  "the user did NOT indicate which project and there is more than one, do NOT guess",
  "— ANSWER by asking which project. If you are unsure or no project matches, ANSWER",
  "in prose instead of proposing. You never execute anything yourself — the user",
  "confirms every action before it runs.",
].join("\n");

/** Render the projects the planner may target. */
function renderProjects(projects: CommandProject[]): string {
  if (projects.length === 0) {
    return "(no projects configured — you cannot propose create_session; answer instead)";
  }
  return projects
    .map(
      (p) =>
        `- id: ${p.id} — name: ${sanitizeDigest(p.name)} — default agent: ${p.agentType} — dir: ${sanitizeDigest(p.directory)}`
    )
    .join("\n");
}

/**
 * Assemble the single prompt handed to the agent: the action+answer instructions,
 * the serialized fleet CONTEXT, the PROJECTS the planner may target, the prior
 * turns, then the user's MESSAGE. Pure → unit-tested. History/message are
 * sanitized so a stray control byte can't ride back into the prompt.
 */
export function buildCommandPrompt({
  context,
  projects,
  history,
  message,
}: CommandPromptInput): string {
  const parts: string[] = [
    COMMAND_PREAMBLE,
    "",
    "=== CONTEXT ===",
    context,
    "",
    "=== PROJECTS ===",
    renderProjects(projects),
  ];

  if (history && history.length > 0) {
    parts.push("", "=== CONVERSATION SO FAR ===");
    for (const turn of history) {
      const label = turn.role === "assistant" ? "Assistant" : "User";
      parts.push(`${label}: ${sanitizeDigest(turn.content)}`);
    }
  }

  parts.push("", "=== MESSAGE ===", sanitizeDigest(message));
  return parts.join("\n");
}

/** The parsed reply: either a question answer (prose) or a raw proposal object
 * still to be validated by the allowlist. */
export type ParsedReply =
  | { kind: "answer"; text: string }
  | { kind: "proposal"; data: unknown };

/** If `text` is wrapped in a ``` or ```json fence, return the inner body. */
function stripCodeFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : text;
}

/**
 * Extract the first BALANCED top-level JSON object substring (brace-matched,
 * string-aware so braces inside quotes don't count). Returns null if there's no
 * complete object. Robust to a model that prefixes/suffixes prose around the JSON.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse an agent reply into an answer or a proposal. CONSERVATIVE: only a parseable
 * JSON object whose `kind` is exactly "proposal" becomes a proposal; everything
 * else (prose, malformed JSON, JSON without that marker) is an answer. This is the
 * fail-safe seam — a misfire degrades to showing prose, never to a spurious action.
 */
export function parseAgentReply(raw: string): ParsedReply {
  const text = raw.trim();
  const candidate = extractFirstJsonObject(stripCodeFence(text));
  if (candidate) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && obj.kind === "proposal") {
        return { kind: "proposal", data: obj };
      }
    } catch {
      // Not valid JSON — fall through to treating the reply as a prose answer.
    }
  }
  return { kind: "answer", text };
}
