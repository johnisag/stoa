/**
 * Custom guardrail rules — loads/saves per-project rule sets from disk.
 *
 * Custom rules are stored as JSON at <STOA_HOME>/guardrails/<projectId>.json.
 * They extend (not replace) the built-in DEFAULT_RULES from lib/guardrails.ts.
 * This module is the server-side I/O layer; validation reuses the pure
 * checkGuardrails/checkRule helpers from lib/guardrails.ts.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { stoaHomeDir } from "./platform";
import { DEFAULT_RULES, type GuardrailRule } from "./guardrails";

/** Max custom rules per project. */
export const MAX_CUSTOM_RULES = 50;
/** Max rule id length. */
export const RULE_ID_MAX = 64;
/** Max pattern length. */
export const RULE_PATTERN_MAX = 500;
/** Max description length. */
export const RULE_DESCRIPTION_MAX = 200;

const GUARDRAILS_DIR = "guardrails";

export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleValidationError";
  }
}

/** Validate a single guardrail rule. Pure → unit-testable. */
export function validateRule(rule: unknown): GuardrailRule {
  if (!rule || typeof rule !== "object") {
    throw new RuleValidationError("rule must be an object");
  }
  const r = rule as Record<string, unknown>;

  // id
  const id = r.id;
  if (typeof id !== "string" || !id.trim()) {
    throw new RuleValidationError("rule id is required");
  }
  if (id.length > RULE_ID_MAX) {
    throw new RuleValidationError(`rule id exceeds ${RULE_ID_MAX} characters`);
  }
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new RuleValidationError(
      "rule id must be lowercase alphanumeric + dashes"
    );
  }

  // description
  const description = r.description;
  if (typeof description !== "string" || !description.trim()) {
    throw new RuleValidationError("rule description is required");
  }
  if (description.length > RULE_DESCRIPTION_MAX) {
    throw new RuleValidationError(
      `rule description exceeds ${RULE_DESCRIPTION_MAX} characters`
    );
  }

  // pattern
  const pattern = r.pattern;
  if (typeof pattern !== "string" || !pattern.trim()) {
    throw new RuleValidationError("rule pattern is required");
  }
  if (pattern.length > RULE_PATTERN_MAX) {
    throw new RuleValidationError(
      `rule pattern exceeds ${RULE_PATTERN_MAX} characters`
    );
  }
  // Validate the regex compiles.
  try {
    new RegExp(pattern, "im");
  } catch {
    throw new RuleValidationError("rule pattern is not a valid regex");
  }

  // severity
  const severity = r.severity;
  if (severity !== "warn" && severity !== "block") {
    throw new RuleValidationError('severity must be "warn" or "block"');
  }

  // scanLines (optional)
  let scanLines: number | undefined;
  if (r.scanLines != null) {
    const s = Number(r.scanLines);
    if (!Number.isFinite(s) || s < 1 || s > 100) {
      throw new RuleValidationError("scanLines must be a number 1-100");
    }
    scanLines = Math.floor(s);
  }

  const result: GuardrailRule = { id, description, pattern, severity };
  if (scanLines != null) result.scanLines = scanLines;
  return result;
}

/** Validate an array of rules. Pure. */
export function validateRules(rules: unknown): GuardrailRule[] {
  if (!Array.isArray(rules)) {
    throw new RuleValidationError("rules must be an array");
  }
  if (rules.length > MAX_CUSTOM_RULES) {
    throw new RuleValidationError(
      `too many custom rules (max ${MAX_CUSTOM_RULES})`
    );
  }
  return rules.map(validateRule);
}

/** The path to a project's custom rules file. */
function rulesFilePath(projectId: string): string {
  return path.join(stoaHomeDir(), GUARDRAILS_DIR, `${projectId}.json`);
}

/** Load custom rules for a project. Returns [] when the file doesn't exist. */
export async function loadCustomRules(
  projectId: string
): Promise<GuardrailRule[]> {
  if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) return [];
  const filePath = rulesFilePath(projectId);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return validateRules(parsed);
  } catch {
    return [];
  }
}

/** Save custom rules for a project. Validates first. */
export async function saveCustomRules(
  projectId: string,
  rules: unknown
): Promise<GuardrailRule[]> {
  if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    throw new RuleValidationError("invalid project id");
  }
  const validated = validateRules(rules);
  const dir = path.join(stoaHomeDir(), GUARDRAILS_DIR);
  await fs.mkdir(dir, { recursive: true });
  const filePath = rulesFilePath(projectId);
  await fs.writeFile(filePath, JSON.stringify(validated, null, 2), "utf-8");
  return validated;
}

/** The combined rule set: built-in defaults + project custom rules. */
export async function getEffectiveRules(
  projectId: string
): Promise<GuardrailRule[]> {
  const custom = await loadCustomRules(projectId);
  // Custom rules with the same id as a default override it (by id).
  const customIds = new Set(custom.map((r) => r.id));
  const defaults = DEFAULT_RULES.filter((r) => !customIds.has(r.id));
  return [...defaults, ...custom];
}
