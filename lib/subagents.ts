/**
 * Reusable scoped subagents (#35) — promote a workflow ROLE into a first-class,
 * provider-native subagent definition (a tools allowlist + an optional per-role
 * model + a persona system prompt) and materialize it into the provider's own
 * subagent directory.
 *
 * A `SubagentDef` is the portable, provider-agnostic shape. A pure serializer
 * (`buildSubagentFileContent`) renders it to the ON-DISK format each provider
 * expects — Claude Code first, whose verified format is a per-subagent directory
 * `~/.claude/agents/<name>/AGENT.md` with YAML frontmatter (name / description /
 * comma-separated `tools` allowlist / optional `model`) followed by a markdown
 * system-prompt body (confirmed against `.claude/agents/code-reviewer/AGENT.md`).
 *
 * Security mirrors lib/skills.ts, because this ALSO writes files into the user's
 * home dir: the subagent NAME is validated to a strict charset (no `.`/`/`/`\`,
 * so no path traversal), Windows reserved device names are rejected, and the
 * resolved path is asserted to stay inside the provider's agents dir. The
 * description becomes a single-line, escaped YAML scalar (never raw user YAML),
 * and each tool token is validated so a hostile entry can't inject a second
 * frontmatter key through the comma-joined `tools:` line. Cross-platform: the dir
 * is built from homeDir() + path.join, never a hardcoded "~" or "/".
 *
 * This layer is ADDITIVE: it reads the existing role vocabulary (workflow-roles)
 * but changes none of its behavior. Role→agent mapping stays single-sourced in
 * ROLE_TO_AGENT; here we only derive a subagent PERSONA (tools/model/prompt) from
 * a role and, when asked, write it to disk.
 */

import fs from "fs";
import path from "path";
import { homeDir } from "./platform";
import {
  getProviderDefinition,
  isValidProviderId,
  type ProviderId,
} from "./providers/registry";
import { isWorkflowRole, type WorkflowRole } from "./command/workflow-roles";

/** Max subagent name length (a directory stem). */
export const SUBAGENT_NAME_MAX_LENGTH = 64;
/** Max description length (a one-line frontmatter scalar). */
export const SUBAGENT_DESCRIPTION_MAX_LENGTH = 256;
/** Max system-prompt body length. */
export const SUBAGENT_PROMPT_MAX_LENGTH = 50_000;
/** Max number of tools in an allowlist (a runaway list bloats the frontmatter). */
export const SUBAGENT_MAX_TOOLS = 64;

/** A subagent name: starts alphanumeric, then alphanumeric / dash / underscore.
 * Excludes `.`, `/`, `\`, and whitespace, so a name can never traverse out of the
 * agents dir or hide an extension. Identical rule to skills — subagent dir names
 * live in the user's home just like command files. */
const SUBAGENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** A tool token in the allowlist. Claude tool identifiers are names optionally
 * carrying a parenthesized scope (e.g. `Bash(git status)`, `Read`, `mcp__x__y`).
 * We allow letters/digits/`_-` plus a single trailing `(...)` scope, and forbid
 * newlines / colons / commas so a token can neither split the comma-joined list
 * nor forge a second YAML key. */
const SUBAGENT_TOOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*(\([^\r\n)]*\))?$/;

/** Windows reserved DEVICE names (case-insensitive): a directory named `con`
 * still names the CON device on Windows. They pass the charset above, so reject
 * them explicitly (same set as skills). */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** The on-disk filename inside a subagent's directory (Claude convention). */
export const SUBAGENT_FILE_NAME = "AGENT.md";

/** A validation failure (an API route would map this to a 400). */
export class SubagentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentValidationError";
  }
}

/**
 * A provider-agnostic subagent definition: a scoped persona with a tools
 * allowlist and an optional per-subagent model. `systemPrompt` is the body
 * (persona instructions); it may be empty. This is the canonical shape a caller
 * builds (e.g. from a workflow role) before it's serialized/materialized.
 */
export interface SubagentDef {
  name: string;
  description: string;
  /** The tools allowlist. An EMPTY array is meaningful for Claude: it omits the
   * `tools:` key entirely, which INHERITS all tools. A non-empty array renders a
   * comma-separated allowlist that restricts the subagent to exactly those. */
  tools: string[];
  /** Optional per-subagent model (e.g. "sonnet"). Omitted → the subagent uses the
   * caller/session's default model. */
  model?: string;
  /** The system-prompt body. Optional; empty → just frontmatter. */
  systemPrompt?: string;
}

/** The minimal fs surface materialization needs — injectable so tests run without
 * touching disk. Defaults to the real node `fs` (sync API, matching skills.ts). */
export interface SubagentFs {
  existsSync(file: string): boolean;
  mkdirSync(dir: string, opts: { recursive: boolean }): void;
  writeFileSync(file: string, data: string, encoding: "utf-8"): void;
}

const realFs: SubagentFs = {
  existsSync: (file) => fs.existsSync(file),
  mkdirSync: (dir, opts) => {
    fs.mkdirSync(dir, opts);
  },
  writeFileSync: (file, data, encoding) => {
    fs.writeFileSync(file, data, encoding);
  },
};

/** Validate + normalize a subagent name (trims, strips a leading "/", strict
 * charset, no reserved device name). Throws SubagentValidationError otherwise.
 * Pure. */
export function normalizeSubagentName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new SubagentValidationError("name is required");
  }
  let name = raw.trim();
  if (name.startsWith("/")) name = name.slice(1);
  if (!name) throw new SubagentValidationError("name is required");
  if (name.length > SUBAGENT_NAME_MAX_LENGTH) {
    throw new SubagentValidationError(
      `name exceeds ${SUBAGENT_NAME_MAX_LENGTH} characters`
    );
  }
  if (!SUBAGENT_NAME_PATTERN.test(name)) {
    throw new SubagentValidationError(
      "name must be letters, numbers, dashes or underscores (no slashes or dots)"
    );
  }
  if (WINDOWS_RESERVED_NAME.test(name)) {
    throw new SubagentValidationError(`"${name}" is a reserved name`);
  }
  return name;
}

/** Validate + normalize the description to a single-line string within the cap.
 * Collapses newlines HERE so the "single line" invariant holds even if a future
 * caller skips the serializer. Pure. */
export function validateSubagentDescription(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw !== "string") {
    throw new SubagentValidationError("description must be a string");
  }
  const d = raw.replace(/[\r\n]+/g, " ").trim();
  if (d.length > SUBAGENT_DESCRIPTION_MAX_LENGTH) {
    throw new SubagentValidationError(
      `description exceeds ${SUBAGENT_DESCRIPTION_MAX_LENGTH} characters`
    );
  }
  return d;
}

/** Validate + normalize the tools allowlist: an array of clean tool tokens,
 * trimmed, de-duplicated (order preserved), within the count cap. A non-array or
 * a token that fails the charset throws. Pure. */
export function validateSubagentTools(raw: unknown): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new SubagentValidationError("tools must be an array of strings");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new SubagentValidationError("each tool must be a string");
    }
    const tool = entry.trim();
    if (!tool) continue; // skip blank entries rather than emit an empty token
    if (!SUBAGENT_TOOL_PATTERN.test(tool)) {
      throw new SubagentValidationError(`invalid tool: ${entry}`);
    }
    if (seen.has(tool)) continue;
    seen.add(tool);
    out.push(tool);
  }
  if (out.length > SUBAGENT_MAX_TOOLS) {
    throw new SubagentValidationError(
      `tools exceeds ${SUBAGENT_MAX_TOOLS} entries`
    );
  }
  return out;
}

/** Validate an optional model string. Empty/absent → undefined (no `model:` key).
 * A model can carry provider-qualified punctuation (`anthropic/claude-opus-4.8`),
 * so allow letters/digits and `. _ - / :` but forbid whitespace and YAML-breaking
 * characters — it's a bare frontmatter scalar. Pure. */
export function validateSubagentModel(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "string") {
    throw new SubagentValidationError("model must be a string");
  }
  const m = raw.trim();
  if (!m) return undefined;
  if (!/^[A-Za-z0-9._/:-]+$/.test(m)) {
    throw new SubagentValidationError("model contains invalid characters");
  }
  return m;
}

/** Validate the optional system-prompt body within the cap. Pure. */
export function validateSubagentPrompt(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw !== "string") {
    throw new SubagentValidationError("systemPrompt must be a string");
  }
  const body = raw.trim();
  if (body.length > SUBAGENT_PROMPT_MAX_LENGTH) {
    throw new SubagentValidationError(
      `systemPrompt exceeds ${SUBAGENT_PROMPT_MAX_LENGTH} characters`
    );
  }
  return body;
}

/** Validate a raw object into a normalized SubagentDef. The single gate every
 * disk-bound path goes through, so no unchecked field reaches the serializer.
 * Pure. */
export function validateSubagentDef(input: {
  name: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
  systemPrompt?: unknown;
}): SubagentDef {
  const name = normalizeSubagentName(input.name);
  const description = validateSubagentDescription(input.description);
  const tools = validateSubagentTools(input.tools);
  const model = validateSubagentModel(input.model);
  const systemPrompt = validateSubagentPrompt(input.systemPrompt);
  const def: SubagentDef = { name, description, tools, systemPrompt };
  if (model !== undefined) def.model = model;
  return def;
}

/** Single-line, double-quoted YAML scalar — so a description can't break the
 * frontmatter or inject extra keys. Same rule as skills.ts's yamlQuote. */
function yamlQuote(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ")}"`;
}

/**
 * Render a SubagentDef to the Claude on-disk AGENT.md content: YAML frontmatter
 * (name, description, optional comma-separated tools allowlist, optional model)
 * followed by the system-prompt body. RE-VALIDATES its input so the pure
 * serializer is safe even if handed a hand-built def that skipped
 * validateSubagentDef (defense in depth — a hostile tool token or multi-line
 * description can't forge a second frontmatter key). Pure → unit-tested.
 */
export function buildSubagentFileContent(def: SubagentDef): string {
  const name = normalizeSubagentName(def.name);
  const description = validateSubagentDescription(def.description);
  const tools = validateSubagentTools(def.tools);
  const model = validateSubagentModel(def.model);
  const body = validateSubagentPrompt(def.systemPrompt);

  const lines = ["---", `name: ${name}`];
  // description is always emitted (even empty) so the frontmatter is a stable,
  // recognizable block; an empty description is a valid quoted scalar.
  lines.push(`description: ${yamlQuote(description)}`);
  // An EMPTY tools list omits the key (Claude then inherits ALL tools); a
  // non-empty list restricts to exactly the allowlist.
  if (tools.length > 0) {
    lines.push(`tools: ${tools.join(", ")}`);
  }
  if (model !== undefined) {
    lines.push(`model: ${model}`);
  }
  lines.push("---");
  const frontmatter = lines.join("\n");
  return body ? `${frontmatter}\n\n${body}\n` : `${frontmatter}\n`;
}

/** The absolute agents directory for a provider, or null if it has none. Built
 * from homeDir() so it's correct on Windows/macOS/Linux. */
export function agentsDirForProvider(providerId: ProviderId): string | null {
  const def = getProviderDefinition(providerId);
  if (!def.agentsDir) return null;
  return path.join(homeDir(), def.agentsDir);
}

/** Resolve + validate a provider id into its agents dir, throwing a clean error
 * when the id is unknown or the provider has no subagent convention. */
function requireAgentsDir(providerId: unknown): {
  id: ProviderId;
  dir: string;
} {
  if (typeof providerId !== "string" || !isValidProviderId(providerId)) {
    throw new SubagentValidationError("unknown provider");
  }
  const dir = agentsDirForProvider(providerId);
  if (!dir) {
    throw new SubagentValidationError(
      `${providerId} has no native subagent directory`
    );
  }
  return { id: providerId, dir };
}

/** The absolute per-subagent directory (`<agentsDir>/<name>`), asserted to be a
 * direct child of the agents dir — defense in depth beyond the name charset. */
export function subagentDir(dir: string, name: string): string {
  const sub = path.join(dir, name);
  if (!path.resolve(sub).startsWith(path.resolve(dir) + path.sep)) {
    throw new SubagentValidationError("invalid name");
  }
  return sub;
}

/** The absolute AGENT.md path for a subagent under a provider's agents dir. */
export function subagentFilePath(dir: string, name: string): string {
  return path.join(subagentDir(dir, name), SUBAGENT_FILE_NAME);
}

/**
 * Materialize a subagent def into a provider's native subagent dir. Validates
 * the def, resolves + asserts the path, creates the per-subagent directory, and
 * writes AGENT.md. The fs is injectable (defaults to real node fs) so tests need
 * no disk. Returns the absolute file path written.
 */
export function materializeSubagent(
  providerId: unknown,
  def: {
    name: unknown;
    description?: unknown;
    tools?: unknown;
    model?: unknown;
    systemPrompt?: unknown;
  },
  opts: { overwrite?: boolean; io?: SubagentFs } = {}
): { path: string; written: boolean } {
  const io = opts.io ?? realFs;
  const { dir } = requireAgentsDir(providerId);
  const validated = validateSubagentDef(def);
  const subDir = subagentDir(dir, validated.name);
  const file = subagentFilePath(dir, validated.name);
  // Clobber guard: with overwrite=false, an existing AGENT.md (a user's
  // hand-authored subagent) is LEFT ALONE — bulk role-install must not silently
  // stomp user files. An explicit single write passes overwrite=true.
  if (opts.overwrite === false && io.existsSync(file)) {
    return { path: file, written: false };
  }
  io.mkdirSync(subDir, { recursive: true });
  io.writeFileSync(file, buildSubagentFileContent(validated), "utf-8");
  return { path: file, written: true };
}

// ---------------------------------------------------------------------------
// Role → subagent def mapping (additive over lib/command/workflow-roles.ts).
// ---------------------------------------------------------------------------

/**
 * The tools allowlist each workflow role should be scoped to when materialized as
 * a subagent. A role that INSPECTS but doesn't write (researcher, review-gate)
 * gets a read-only set; a role that CHANGES code (engineer, ui-ux, integrator,
 * tester) additionally gets Edit/Write/Bash. Kept as a single auditable constant,
 * mirroring ROLE_TO_AGENT. An empty array would inherit all tools — we prefer an
 * explicit allowlist so the persona is actually scoped.
 */
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;
const WRITE_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"] as const;

const ROLE_TOOLS: Record<WorkflowRole, readonly string[]> = {
  researcher: READ_ONLY_TOOLS,
  architect: READ_ONLY_TOOLS,
  "software-engineer": WRITE_TOOLS,
  "ui-ux": WRITE_TOOLS,
  tester: WRITE_TOOLS,
  integrator: WRITE_TOOLS,
  "review-gate": READ_ONLY_TOOLS,
};

/**
 * A short, subagent-facing DESCRIPTION per role (the frontmatter `description:`
 * scalar Claude shows in its subagent picker). Deliberately NOT sourced from
 * workflow-roles' ROLE_GUIDANCE: that string is generator-facing fleet advice,
 * is edited for an unrelated concern, and one entry already sits ~1 char under
 * the 256 description cap — reusing it would let a routine guidance edit throw
 * from roleToSubagentDef and 500 the whole "install all roles" action. Owning
 * these here keeps the subagent contract independent (a test asserts each stays
 * comfortably under the cap). Each is a single terse line, well within 256 chars.
 */
const ROLE_SUBAGENT_DESCRIPTION: Record<WorkflowRole, string> = {
  researcher:
    "Investigates the codebase, docs, and prior art and reports cited findings. Read-only.",
  architect:
    "Designs the architecture and the component/module breakdown from the research, with the trade-offs made explicit. Read-only.",
  "software-engineer":
    "Implements the code to match the agreed design in surgical, well-tested changes.",
  "ui-ux":
    "Designs and implements accessible, responsive UI/UX consistent with the existing design system.",
  tester:
    "Builds the unit + integration test suite, covering the happy path, edge cases, and failure modes.",
  integrator:
    "Integrates every slice into one coherent, working whole and verifies the build and tests are green.",
  "review-gate":
    "Final review + sign-off on correctness/security, conventions/cross-platform, and simplicity/UX. Read-only.",
};

/**
 * The system-prompt PERSONA for each role, addressed to that agent. Like the
 * description above, deliberately NOT the generator's ROLE_GUIDANCE topology prose
 * ("~3 roots, run in parallel", "the sink") — that reads as noise inside a
 * standalone subagent's instructions. These are the instructions the materialized
 * AGENT.md actually needs: what this one agent does. The read-only roles restate
 * their no-write scope so the persona matches the tools allowlist.
 */
const ROLE_PERSONA: Record<WorkflowRole, string> = {
  researcher:
    "You investigate the problem space — the codebase, docs, and prior art — and report concrete, cited findings. You read and search; you do not modify code.",
  architect:
    "You design the solution from the research: the overall architecture and the component/module breakdown, with the trade-offs made explicit. You read and search; you do not modify code.",
  "software-engineer":
    "You implement the code to match the agreed design, in surgical, well-tested changes that match the surrounding style.",
  "ui-ux":
    "You design and implement the UI/UX — accessible, responsive, and consistent with the existing design system.",
  tester:
    "You develop the test suite (unit + integration), covering the happy path, edge cases, and failure modes, and you make it pass.",
  integrator:
    "You integrate every slice into one coherent, working whole, resolving conflicts and verifying the build and tests are green.",
  "review-gate":
    "You are the final reviewer: you judge the whole change on correctness/security, conventions/cross-platform, and simplicity/UX, and sign off only if all three pass. You read and search; you do not modify code.",
};

/**
 * Derive a provider-agnostic SubagentDef from a workflow role: a subagent-owned
 * description + persona (ROLE_SUBAGENT_DESCRIPTION / ROLE_PERSONA, both kept
 * independent of the generator's ROLE_GUIDANCE) and the tools allowlist from
 * ROLE_TOOLS. `model` is left UNSET by default (the subagent then uses the
 * session's model) unless an explicit `model` override is passed — when it is,
 * it's validated. Pure; changes no workflow-role behavior.
 */
export function roleToSubagentDef(
  role: WorkflowRole,
  opts: { model?: string } = {}
): SubagentDef {
  if (!isWorkflowRole(role)) {
    // isWorkflowRole is the membership gate; a caller passing a bad literal is a
    // programmer error, but fail closed rather than emit a malformed def.
    throw new SubagentValidationError(`unknown role: ${String(role)}`);
  }
  return validateSubagentDef({
    name: role,
    description: ROLE_SUBAGENT_DESCRIPTION[role],
    tools: [...ROLE_TOOLS[role]],
    model: opts.model,
    systemPrompt: `You are the "${role}" role in a Stoa workflow.\n\n${ROLE_PERSONA[role]}`,
  });
}

/**
 * Materialize a workflow role as a native subagent for a provider (validates,
 * writes `<agentsDir>/<role>/AGENT.md`). Convenience over
 * roleToSubagentDef + materializeSubagent. fs is injectable for tests. `model`
 * is left unset (session model) unless an explicit override is passed;
 * `overwrite` defaults true. Returns the path and whether it was written.
 */
export function materializeRoleSubagent(
  providerId: unknown,
  role: WorkflowRole,
  opts: { model?: string; overwrite?: boolean; io?: SubagentFs } = {}
): { path: string; written: boolean } {
  const def = roleToSubagentDef(role, { model: opts.model });
  return materializeSubagent(providerId, def, {
    overwrite: opts.overwrite,
    io: opts.io,
  });
}

/** Every workflow role that can be materialized as a subagent (the ROLE_TOOLS
 *  keys — the roles this module scopes a tools allowlist for). */
export const MATERIALIZABLE_ROLES = Object.keys(ROLE_TOOLS) as WorkflowRole[];

/**
 * Bulk-install ALL workflow roles as subagents for a provider. Existing
 * hand-authored files are LEFT ALONE (overwrite=false) — this is a one-click
 * "install the role library" action, not a stomp. The provider is validated ONCE
 * up front (a bad id throws before any write). Returns which roles were written
 * vs skipped (already present) plus the destination `dir`, so a caller can tell
 * the user exactly where the files landed. The `io` seam keeps it testable.
 *
 * Not atomic: if a write throws partway (EACCES/ENOSPC/…), earlier roles remain
 * on disk. Content is deterministic and overwrite=false, so re-running safely
 * installs the rest — the route surfaces that on failure.
 */
export function materializeAllRoles(
  providerId: unknown,
  opts: { io?: SubagentFs } = {}
): { written: WorkflowRole[]; skipped: WorkflowRole[]; dir: string } {
  const { id, dir } = requireAgentsDir(providerId);
  const written: WorkflowRole[] = [];
  const skipped: WorkflowRole[] = [];
  for (const role of MATERIALIZABLE_ROLES) {
    const r = materializeRoleSubagent(id, role, {
      overwrite: false,
      io: opts.io,
    });
    (r.written ? written : skipped).push(role);
  }
  return { written, skipped, dir };
}
