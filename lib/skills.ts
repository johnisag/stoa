/**
 * Skills → native per-provider slash commands (#8). Author a command in the UI;
 * Stoa writes a markdown file into the provider's NATIVE custom-command directory
 * (Claude Code: `~/.claude/commands/<name>.md`), so it becomes a real `/<name>`
 * the provider's own TUI autocompletes — zero custom dispatch, exactly amux's
 * trick, but mapped per-provider via the `commandsDir` descriptor on
 * ProviderDefinition rather than hardcoding Claude's path.
 *
 * The risky part is that this writes files into the user's home dir from UI input,
 * so the command NAME is validated to a strict charset (no `.`/`/`/`\`, so no path
 * traversal) AND the resolved file path is asserted to stay inside the provider's
 * commands dir. The body is the user's own prompt template, written verbatim; the
 * description becomes a single-line, escaped YAML frontmatter scalar (never raw
 * user YAML). Cross-platform: the dir is built from homeDir() + path.join, never a
 * hardcoded "~" or "/".
 */

import fs from "fs";
import path from "path";
import { homeDir } from "./platform";
import {
  getProviderDefinition,
  getAllProviderDefinitions,
  isValidProviderId,
  type ProviderId,
} from "./providers/registry";

/** Max command-name length (a filename stem). */
export const SKILL_NAME_MAX_LENGTH = 64;
/** Max description length (a one-line frontmatter scalar). */
export const SKILL_DESCRIPTION_MAX_LENGTH = 256;
/** Max body length (the prompt template). */
export const SKILL_BODY_MAX_LENGTH = 50_000;

/** A command name: starts alphanumeric, then alphanumeric / dash / underscore.
 * Crucially excludes `.`, `/`, `\`, and whitespace, so a name can never traverse
 * out of the commands dir or hide an extension. */
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Windows reserved DEVICE names (case-insensitive, extension-independent): a
 * file named `con.md` opens the CON device on Windows — a write hangs, `nul`
 * silently discards. They pass the charset above, so reject them explicitly. */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A validation failure (the API route maps this to a 400). */
export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillValidationError";
  }
}

/** A command as listed/returned (the body isn't included in a list). */
export interface SkillSummary {
  name: string;
  description: string;
}

/** Validate + normalize a command name: trims, strips a leading "/" (users type
 * "/commit"), and requires the strict charset. Throws otherwise. Pure. */
export function normalizeSkillName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new SkillValidationError("name is required");
  }
  let name = raw.trim();
  if (name.startsWith("/")) name = name.slice(1);
  if (!name) throw new SkillValidationError("name is required");
  if (name.length > SKILL_NAME_MAX_LENGTH) {
    throw new SkillValidationError(
      `name exceeds ${SKILL_NAME_MAX_LENGTH} characters`
    );
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new SkillValidationError(
      "name must be letters, numbers, dashes or underscores (no slashes or dots)"
    );
  }
  if (WINDOWS_RESERVED_NAME.test(name)) {
    throw new SkillValidationError(`"${name}" is a reserved name`);
  }
  return name;
}

/** Validate + normalize the description to a single-line string within the cap.
 * Collapses any newlines HERE (not only at YAML-quote time) so the "single line"
 * invariant is enforced locally and can't leak through a future caller. Pure. */
export function validateSkillDescription(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw !== "string") {
    throw new SkillValidationError("description must be a string");
  }
  const d = raw.replace(/[\r\n]+/g, " ").trim();
  if (d.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    throw new SkillValidationError(
      `description exceeds ${SKILL_DESCRIPTION_MAX_LENGTH} characters`
    );
  }
  return d;
}

/** Validate the body: a non-empty string within the cap. Pure. */
export function validateSkillBody(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new SkillValidationError("body must be a string");
  }
  const body = raw.trim();
  if (!body) throw new SkillValidationError("body is required");
  if (body.length > SKILL_BODY_MAX_LENGTH) {
    throw new SkillValidationError(
      `body exceeds ${SKILL_BODY_MAX_LENGTH} characters`
    );
  }
  return body;
}

/** The providers that have a native custom-command convention wired. */
export function supportedSkillProviders(): { id: ProviderId; name: string }[] {
  return getAllProviderDefinitions()
    .filter((p) => !!p.commandsDir)
    .map((p) => ({ id: p.id, name: p.name }));
}

/** The absolute commands directory for a provider, or null if it has none. Built
 * from homeDir() so it's correct on Windows/macOS/Linux. */
export function commandsDirForProvider(providerId: ProviderId): string | null {
  const def = getProviderDefinition(providerId);
  if (!def.commandsDir) return null;
  return path.join(homeDir(), def.commandsDir);
}

/** Resolve + validate a provider id arg into its commands dir, throwing a clean
 * SkillValidationError when the id is unknown or the provider has no commands. */
function requireCommandsDir(providerId: unknown): {
  id: ProviderId;
  dir: string;
} {
  if (typeof providerId !== "string" || !isValidProviderId(providerId)) {
    throw new SkillValidationError("unknown provider");
  }
  const dir = commandsDirForProvider(providerId);
  if (!dir) {
    throw new SkillValidationError(
      `${providerId} has no native custom-command directory`
    );
  }
  return { id: providerId, dir };
}

/** The absolute file path for a command, asserted to resolve to a direct child of
 * `dir` (defense in depth beyond the name charset — a traversal would have already
 * been rejected by normalizeSkillName). */
function skillFilePath(dir: string, name: string): string {
  const file = path.join(dir, `${name}.md`);
  if (!path.resolve(file).startsWith(path.resolve(dir) + path.sep)) {
    throw new SkillValidationError("invalid name");
  }
  return file;
}

/** Single-line, double-quoted YAML scalar — so a description can't break the
 * frontmatter or inject extra keys. */
function yamlQuote(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ")}"`;
}

/** Build the command file content: optional `description:` frontmatter + the body.
 * The body is written VERBATIM (it's the user's own prompt template) — a body that
 * itself opens with a `---` frontmatter block, including capability keys like
 * `allowed-tools`, is intentional and identical to the user hand-editing the file.
 * Pure → unit-tested. */
export function buildSkillFileContent(
  description: string,
  body: string
): string {
  const front = description
    ? `---\ndescription: ${yamlQuote(description)}\n---\n\n`
    : "";
  return `${front}${body.trimEnd()}\n`;
}

/** Parse the `description` back out of a command file's frontmatter (empty when
 * there's none). Pure → unit-tested. */
export function parseSkillDescription(content: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return "";
  const dm = fm[1].match(/^description:\s*(.*)$/m);
  if (!dm) return "";
  let v = dm[1].trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return v;
}

/** List a provider's commands (name + description), sorted by name. Returns [] if
 * the dir doesn't exist yet. */
export function listSkills(providerId: unknown): SkillSummary[] {
  const { dir } = requireCommandsDir(providerId);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return []; // dir doesn't exist yet → no commands
  }
  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    if (!SKILL_NAME_PATTERN.test(name)) continue; // skip foreign/namespaced files
    let content = "";
    try {
      content = fs.readFileSync(path.join(dir, entry), "utf-8");
    } catch {
      continue;
    }
    skills.push({ name, description: parseSkillDescription(content) });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one command's full body (for editing), or null if it doesn't exist. */
export function getSkill(
  providerId: unknown,
  rawName: unknown
): { name: string; description: string; body: string } | null {
  const { dir } = requireCommandsDir(providerId);
  const name = normalizeSkillName(rawName);
  const file = skillFilePath(dir, name);
  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const description = parseSkillDescription(content);
  // Recover the body. Only strip a leading frontmatter block when we actually
  // parsed a description out of it (writeSkill writes frontmatter ONLY when there
  // IS a description) — so a description-less command whose BODY happens to start
  // with a `---` line isn't mistaken for frontmatter and truncated. trimEnd undoes
  // the trailing newline writeSkill adds, so an unedited round-trip re-saves the same.
  const body = (
    description
      ? content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "")
      : content
  ).trimEnd();
  return { name, description, body };
}

/** Create/overwrite a command file. Validates everything, creates the dir if
 * needed, and returns the stored summary. */
export function writeSkill(input: {
  provider: unknown;
  name: unknown;
  description?: unknown;
  body: unknown;
}): SkillSummary {
  const { dir } = requireCommandsDir(input.provider);
  const name = normalizeSkillName(input.name);
  const description = validateSkillDescription(input.description);
  const body = validateSkillBody(input.body);
  const file = skillFilePath(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buildSkillFileContent(description, body), "utf-8");
  return { name, description };
}

/** Delete a command file. Returns true when one was removed, false when it didn't
 * exist. A real failure (EACCES/EPERM — e.g. the file is locked open on Windows)
 * is re-thrown so the route surfaces a 500 rather than falsely reporting success. */
export function deleteSkill(providerId: unknown, rawName: unknown): boolean {
  const { dir } = requireCommandsDir(providerId);
  const name = normalizeSkillName(rawName);
  const file = skillFilePath(dir, name);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
