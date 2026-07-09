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
import {
  WORKFLOW_ROLES,
  ROLE_GUIDANCE,
  MAX_GENERATED_STEPS,
} from "./workflow-roles";
import { STOA_DEFAULT_OUTPUT_FILE } from "@/lib/pipeline/engine";

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
  '       "name":"<optional short session title>",',
  '       "initialPrompt":"<optional first message to send the agent — the seed prompt>"}}',
  "",
  "   - dispatch_issue: create a local (GitHub-free) task in the dispatch backlog.",
  '     {"kind":"proposal","action":"dispatch_issue","params":{',
  '       "repoId":"<a dispatch repo id from CONTEXT>",',
  '       "title":"<short task title>",',
  '       "body":"<optional fuller task description>"}}',
  "",
  "   - open_view: navigate the UI to a specific view (client-side only — nothing runs).",
  '     {"kind":"proposal","action":"open_view","params":{',
  '       "view":"analytics" | "dispatch" | "verdict-inbox" | "fleet-board" | "fleet-management"}}',
  "",
  "   - list_sessions: return a summary of the user's current sessions (read-only).",
  '     {"kind":"proposal","action":"list_sessions","params":{',
  '       "status":"running" | "idle" | "waiting"}}',
  "     (omit status to list all sessions)",
  "",
  "3. PLAN a sequence of steps when the user asks for multi-step work (research then",
  "   implement, implement then test, etc.). A plan is only appropriate when the",
  "   steps are GENUINELY sequential — step N depends on the output of step N-1.",
  "   To propose a plan, reply with ONLY a single JSON object and NOTHING else:",
  '   {"kind":"plan","name":"<short plan title, max 120 chars>","steps":[',
  '     {"stepId":"step-1","description":"<what this step does, max 200 chars>",',
  '      "action":"create_session","params":{<same params as a single create_session>}},',
  "     ...",
  "   ]}",
  "",
  "   Rules for plans:",
  "   - Use a plan ONLY when steps are genuinely sequential (step N depends on N-1).",
  "   - 2 to 10 steps maximum — no more.",
  "   - Each step's action must be 'create_session' or 'dispatch_issue' only.",
  "     (open_view is client-side only and produces no output a later step could",
  "      consume; list_sessions is read-only and returns data, not a durable side",
  "      effect — neither belongs in a sequential plan.)",
  "   - Each step's params follow the same rules as a single PROPOSE above.",
  "   - Do NOT mix a plan and a proposal in the same reply.",
  "   - Do NOT emit a plan for a single action — use a proposal instead.",
  "",
  "Rules:",
  "- Only propose an action when the user clearly requests it.",
  "- For create_session: choose projectId ONLY from the PROJECTS list. If the user",
  "  did NOT indicate which project and there is more than one, ANSWER by asking.",
  "  Use initialPrompt only when the user specifies a first message for the agent.",
  "- For dispatch_issue: use a repoId from the CONTEXT dispatch repos. If none are",
  "  configured, ANSWER explaining that no dispatch repos are set up.",
  "- For open_view: map navigation requests to the closest view name above.",
  "- For list_sessions: use when the user asks to see/list their sessions.",
  "- If you are unsure or no match exists, ANSWER in prose instead of proposing.",
  "- You never execute anything yourself — the user confirms every action first.",
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

/** Inputs for the assisted-workflow generator prompt. The project grounds the
 * design (name/dir for the agent's reasoning only — the server sets the actual
 * workingDirectory from the resolved project, never the agent). */
export interface GenerateWorkflowPromptInput {
  /** The user's high-level description of what they want built. */
  summary: string;
  projectName: string;
  projectDir: string;
  /** Optional grounded fleet/context, same as the planner. */
  context?: string;
}

const GENERATE_WORKFLOW_PREAMBLE = [
  "You are Stoa's workflow DESIGNER. Given a high-level goal, you DESIGN a",
  "multi-agent workflow — a DAG of role-based agent steps — and output it as a",
  "single JSON object. You do NOT build or run anything: your entire job is to",
  "populate the design. The user reviews and edits it in a visual canvas, then",
  "decides whether to run it. Nothing you emit is ever executed automatically.",
  "",
  "Output EXACTLY ONE JSON object and NOTHING else (no prose, no code fences):",
  '  {"kind":"workflow","spec":{"name":"<short title>","steps":[ <step>, ... ]}}',
  "",
  "Each <step> is:",
  '  {"id":"<unique-kebab-id, no spaces>",',
  '   "role":"<one of the ROLES below>",',
  '   "name":"<short human label, e.g. \\"Researcher: data model\\">",',
  '   "task":"<the full, specific instructions for this agent>",',
  '   "dependsOn":["<id>", ...],   // steps that must finish first (omit for roots)',
  '   "outputFile":"<relative file the step writes, e.g. STOA_OUTPUT.md>"}',
  "",
  "Do NOT emit `agent`, `model`, or `workingDirectory` — the server assigns the",
  "agent from the role and sets the directory from the project.",
].join("\n");

function renderRoles(): string {
  return WORKFLOW_ROLES.map((r) => `  - ${r}: ${ROLE_GUIDANCE[r]}`).join("\n");
}

const GENERATE_WORKFLOW_RULES = [
  "HARD RULES (a design that breaks one of these is rejected):",
  "- Every step id is unique and has no leading/trailing spaces; every step has a",
  "  non-empty task and a role from the list above.",
  "- Every dependsOn id must reference a step that exists, and the graph must be ACYCLIC.",
  "- A {{steps.<upstreamId>.output}} placeholder may appear in a step's task ONLY if",
  "  <upstreamId> is in that step's dependency chain (add it to dependsOn).",
  `- At most ${MAX_GENERATED_STEPS} steps total.`,
  "",
  "DESIGN GUIDANCE (for a workflow that's actually good to run):",
  "- Use the canonical fleet, SCALED to the goal — a richer goal earns more nodes:",
  "  ~3 researchers → 2 architects (architecture + components) → ~3 software-engineers",
  "  + ~2 ui-ux → ~2 testers → 1 integrator → exactly 1 review-gate (the sink).",
  "- For one step's result to reach a later step, the later step references",
  `  {{steps.<upstreamId>.output}} AND the producing step should write its deliverable`,
  `  to its outputFile (default ${STOA_DEFAULT_OUTPUT_FILE}) — otherwise the reference`,
  "  resolves to empty.",
  "- The review-gate depends on the integrator and judges the whole result on three",
  "  dimensions — correctness/security, conventions/cross-platform, simplicity/UX —",
  "  signing off only if all three pass.",
].join("\n");

/**
 * Build the prompt that asks an agent to DESIGN a workflow (and only design it).
 * Pure → unit-tested. The summary/context are sanitized so a stray control byte
 * can't ride back into the prompt; the project grounds the design but the server
 * owns the real working directory.
 */
export function buildGenerateWorkflowPrompt({
  summary,
  projectName,
  projectDir,
  context,
}: GenerateWorkflowPromptInput): string {
  const parts: string[] = [
    GENERATE_WORKFLOW_PREAMBLE,
    "",
    "=== ROLES ===",
    renderRoles(),
    "",
    GENERATE_WORKFLOW_RULES,
    "",
    "=== PROJECT (for grounding only — do not output a path) ===",
    `name: ${sanitizeDigest(projectName)} — dir: ${sanitizeDigest(projectDir)}`,
  ];
  if (context && context.trim()) {
    parts.push("", "=== CONTEXT ===", sanitizeDigest(context));
  }
  parts.push(
    "",
    "=== GOAL TO DESIGN A WORKFLOW FOR ===",
    sanitizeDigest(summary)
  );
  return parts.join("\n");
}

/** The parsed reply: a question answer (prose), a raw proposal object, a raw
 * workflow-design object, or a raw plan object — the latter three still to be
 * validated by the allowlist / the workflow validator / the plan validator. */
export type ParsedReply =
  | { kind: "answer"; text: string }
  | { kind: "proposal"; data: unknown }
  | { kind: "workflow"; data: unknown }
  | { kind: "plan"; data: unknown };

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
 * Parse an agent reply into an answer, a proposal, or a workflow design.
 * CONSERVATIVE: only a parseable JSON object whose `kind` is exactly "proposal"
 * or "workflow" becomes that; everything else (prose, malformed JSON, JSON without
 * a known marker) is an answer. This is the fail-safe seam — a misfire degrades to
 * showing prose, never to a spurious action or a bogus generated canvas.
 */
export function parseAgentReply(raw: string): ParsedReply {
  const text = raw.trim();
  const candidate = extractFirstJsonObject(stripCodeFence(text));
  if (candidate) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object") {
        if (obj.kind === "proposal") return { kind: "proposal", data: obj };
        if (obj.kind === "workflow") return { kind: "workflow", data: obj };
        if (obj.kind === "plan") return { kind: "plan", data: obj };
      }
    } catch {
      // Not valid JSON — fall through to treating the reply as a prose answer.
    }
  }
  return { kind: "answer", text };
}
