/**
 * Pure import adapters for turning existing Stoa planning surfaces into one
 * Fleet draft-plan shape. This module deliberately performs no persistence and
 * does not alter the source Pipeline/Builder/Dispatch objects.
 */
import type { BuilderDoc, SavedWorkflow } from "../pipeline/builder-model";
import { docToSpec } from "../pipeline/builder-model";
import { normalizeClaim } from "../dispatch/claims";
import type { DispatchRepo, IssueDispatch, PlanTask } from "../dispatch/types";
import {
  isFreeTextModelAgent,
  isSafeModel,
  isSupportedModelForAgent,
} from "../model-catalog";
import { isValidProviderId, type ProviderId } from "../providers/registry";
import { parsePipelineSpec, validateSpec } from "../pipeline/engine";
import type { PipelineSpec, PipelineStep } from "../pipeline/types";
import { parseVerifySteps } from "../verification/runner";
import {
  FLEET_PLAN_FILE_CLAIM_MAX,
  FLEET_PLAN_FILE_CLAIMS_MAX,
  FLEET_PLAN_TASK_DESCRIPTION_MAX,
  FLEET_PLAN_TASK_TITLE_MAX,
  FLEET_PLAN_TEXT_MAX,
  parseFleetPlanText,
} from "./plan";

export const FLEET_SOURCE_TASK_CAP = 40;
export const FLEET_SOURCE_ID_MAX = 64;
export const FLEET_SOURCE_MODEL_MAX = 160;
export const FLEET_SOURCE_PATH_MAX = 1024;

const ACCEPTANCE_MAX = 2_000;
const VERIFY_COMMAND_MAX = 500;
const SOURCE_REF_MAX = 128;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const GLOB_CHARACTERS = /[*?\[\]{}!]/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const READ_ONLY_TASK_TYPES = new Set([
  "explore",
  "milestone",
  "review",
  "scope",
  "verify",
]);

export type FleetSourceKind =
  "text" | "pipeline" | "builder" | "dispatch_planner" | "dispatch_issue";

export type FleetSourceProvider = Exclude<ProviderId, "shell">;
export type FleetSourceClaimAccess = "read" | "write";

export interface FleetSourceFileClaim {
  path: string;
  access: FleetSourceClaimAccess;
}

export interface FleetSourceDraftTask {
  /** Stable within this imported draft and used by dependsOn. */
  id: string;
  order: number;
  title: string;
  description: string | null;
  taskType: string;
  dependsOn: string[];
  provider: FleetSourceProvider | null;
  model: string | null;
  workingDirectory: string | null;
  /** Optional source hint; the service must bind it to a registered target. */
  baseBranch?: string | null;
  claimMode: FleetSourceClaimAccess;
  fileClaims: FleetSourceFileClaim[];
  acceptanceCriteria: string | null;
  verifyCommand: string | null;
  /** Stable identifier in the source system, without implying a DB relation. */
  sourceRef: string;
  /** Dispatch row identity for issue imports; validated before persistence. */
  sourceIssueId?: string | null;
  sourceIssueNumber?: number | null;
}

export interface FleetSourceProvenance {
  kind: FleetSourceKind;
  sourceId: string | null;
  sourceName: string | null;
}

export interface FleetSourceRepositoryHints {
  repoId: string | null;
  projectId: string | null;
  repoSlug: string | null;
  workingDirectory: string | null;
  baseBranch: string | null;
}

/** The one validated, side-effect-free input shape consumed by Fleet import UI/API. */
export interface FleetSourceDraftPlanInput {
  name: string;
  goal: string;
  tasks: FleetSourceDraftTask[];
  provenance: FleetSourceProvenance;
  repository: FleetSourceRepositoryHints;
}

export interface FleetSourceValidationIssue {
  code: string;
  path: string;
  message: string;
}

export type FleetSourceAdapterResult =
  | { ok: true; draft: FleetSourceDraftPlanInput }
  | { ok: false; errors: FleetSourceValidationIssue[] };

export interface FleetTextSourceInput {
  kind: "text";
  text: string;
  name?: string;
  sourceId?: string;
  provider?: string | null;
  model?: string | null;
  claimMode?: FleetSourceClaimAccess;
  /** Default direct-argv verification command for imported write tasks. */
  verifyCommand?: string | null;
  repoId?: string | null;
  projectId?: string | null;
  workingDirectory?: string | null;
  baseBranch?: string | null;
}

export interface FleetPipelineSourceInput {
  kind: "pipeline";
  spec: PipelineSpec | string;
  /** Default direct-argv verification command for imported write tasks. */
  verifyCommand: string;
  sourceId?: string;
  goal?: string;
  repoId?: string | null;
  projectId?: string | null;
  baseBranch?: string | null;
}

export interface FleetBuilderSourceInput {
  kind: "builder";
  workflow: BuilderDoc | SavedWorkflow;
  /** Default direct-argv verification command for imported write tasks. */
  verifyCommand: string;
  sourceId?: string;
  goal?: string;
  repoId?: string | null;
  baseBranch?: string | null;
}

export interface FleetDispatchPlannerSourceInput {
  kind: "dispatch_planner";
  tasks: PlanTask[];
  /** Dependency indexes parallel to tasks; omitted entries have no dependencies. */
  dependencies?: number[][];
  name?: string;
  goal?: string;
  sourceId?: string;
  repo?: Partial<DispatchRepo> | null;
  provider?: string | null;
  model?: string | null;
  /** Defaults to the Dispatch repository command when omitted. */
  verifyCommand?: string | null;
}

export interface FleetDispatchIssueSourceInput {
  kind: "dispatch_issue";
  issues: IssueDispatch[];
  /** Dispatch row id -> row ids it depends on. */
  dependencies?: Record<string, string[]>;
  name?: string;
  goal?: string;
  sourceId?: string;
  repo?: Partial<DispatchRepo> | null;
  provider?: string | null;
  model?: string | null;
  /** Defaults to the Dispatch repository command when omitted. */
  verifyCommand?: string | null;
}

export type FleetSourceInput =
  | FleetTextSourceInput
  | FleetPipelineSourceInput
  | FleetBuilderSourceInput
  | FleetDispatchPlannerSourceInput
  | FleetDispatchIssueSourceInput;

class SourceInputError extends Error {
  constructor(readonly issue: FleetSourceValidationIssue) {
    super(issue.message);
  }
}

function reject(code: string, path: string, message: string): never {
  throw new SourceInputError({ code, path, message });
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    reject("invalid_type", path, `${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    reject("invalid_type", path, `${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function boundedText(
  value: unknown,
  path: string,
  max: number,
  options: { required?: boolean; multiline?: boolean } = {}
): string | null {
  if (value == null || value === "") {
    if (options.required) reject("required", path, `${path} is required`);
    return null;
  }
  if (typeof value !== "string") {
    reject("invalid_type", path, `${path} must be a string`);
  }
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    if (options.required) reject("required", path, `${path} is required`);
    return null;
  }
  if (normalized.length > max) {
    reject("too_large", path, `${path} exceeds ${max} characters`);
  }
  if (CONTROL_CHARACTERS.test(normalized)) {
    reject("unsafe_text", path, `${path} contains control characters`);
  }
  return options.multiline ? normalized : normalized.replace(/\s+/g, " ");
}

function optionalHint(value: unknown, path: string, max = SOURCE_REF_MAX) {
  return boundedText(value, path, max) ?? null;
}

function pathHint(value: unknown, path: string): string | null {
  const hint = boundedText(value, path, FLEET_SOURCE_PATH_MAX);
  if (hint && /[;&|`$(){}<>\n\r"']/.test(hint)) {
    reject("unsafe_path", path, `${path} contains unsafe characters`);
  }
  return hint;
}

function branchHint(value: unknown, path: string): string | null {
  const branch = boundedText(value, path, 255);
  if (
    branch &&
    (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
      branch.includes("..") ||
      branch.includes("@{") ||
      branch.endsWith(".") ||
      branch.endsWith("/"))
  ) {
    reject("unsafe_branch", path, `${path} is not a safe branch hint`);
  }
  return branch;
}

function verifyCommand(
  value: unknown,
  path = "verifyCommand",
  required = false
): string | null {
  if (required && (value == null || value === "")) {
    reject(
      "missing_verify_command",
      path,
      "write tasks require a verification command"
    );
  }
  const command = boundedText(value, path, VERIFY_COMMAND_MAX);
  if (required && !command) {
    reject(
      "missing_verify_command",
      path,
      "write tasks require a verification command"
    );
  }
  if (!command) return null;
  if (!("steps" in parseVerifySteps(command))) {
    reject(
      "unsafe_verify_command",
      path,
      `${path} must use direct argv steps separated only by &&`
    );
  }
  return command;
}

function normalizeProvider(
  value: unknown,
  path: string
): FleetSourceProvider | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    reject("invalid_provider", path, `${path} must be a provider id`);
  }
  const provider = value.trim().toLowerCase();
  if (!isValidProviderId(provider) || provider === "shell") {
    reject("invalid_provider", path, `${path} is not a worker provider`);
  }
  return provider;
}

function normalizeModel(
  value: unknown,
  provider: FleetSourceProvider | null,
  path: string
): string | null {
  const model = boundedText(value, path, FLEET_SOURCE_MODEL_MAX);
  if (!model) return null;
  if (!provider) {
    reject("model_without_provider", path, `${path} requires a provider`);
  }
  if (!isSafeModel(model)) {
    reject("unsafe_model", path, `${path} contains unsafe characters`);
  }
  if (
    !isFreeTextModelAgent(provider) &&
    !isSupportedModelForAgent(provider, model)
  ) {
    reject(
      "unsupported_model",
      path,
      `${path} is not supported by provider ${provider}`
    );
  }
  return model;
}

function explicitTaskId(value: unknown, path: string): string {
  const id = boundedText(value, path, FLEET_SOURCE_ID_MAX, { required: true });
  if (!id || !TASK_ID.test(id)) {
    reject("invalid_task_id", path, `${path} is not a safe stable task id`);
  }
  return id;
}

function slugBase(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, FLEET_SOURCE_ID_MAX);
  return slug || "task";
}

function stableGeneratedIds(titles: string[]): string[] {
  const used = new Set<string>();
  return titles.map((title, index) => {
    const base = slugBase(title) || `task-${index + 1}`;
    let id = base;
    for (let suffix = 2; used.has(id); suffix += 1) {
      const tail = `-${suffix}`;
      id = `${base.slice(0, FLEET_SOURCE_ID_MAX - tail.length)}${tail}`;
    }
    used.add(id);
    return id;
  });
}

function normalizeClaims(
  value: unknown,
  access: FleetSourceClaimAccess,
  path: string
): FleetSourceFileClaim[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    reject("invalid_claims", path, `${path} must be an array`);
  }
  if (value.length > FLEET_PLAN_FILE_CLAIMS_MAX) {
    reject(
      "too_many_claims",
      path,
      `${path} exceeds ${FLEET_PLAN_FILE_CLAIMS_MAX} claims`
    );
  }
  const claims: FleetSourceFileClaim[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (
      typeof raw !== "string" ||
      raw.trim().length > FLEET_PLAN_FILE_CLAIM_MAX
    ) {
      reject(
        "invalid_claim",
        `${path}[${index}]`,
        "file claim is invalid or too long"
      );
    }
    if (GLOB_CHARACTERS.test(raw)) {
      reject(
        "invalid_claim",
        `${path}[${index}]`,
        "file claims cannot contain globs"
      );
    }
    const normalized = normalizeClaim(raw);
    if (!normalized) {
      reject(
        "invalid_claim",
        `${path}[${index}]`,
        "file claim must be repo-relative"
      );
    }
    if (!claims.some((claim) => claim.path === normalized)) {
      claims.push({ path: normalized, access });
    }
  }
  return claims;
}

function claimsFromJson(
  value: unknown,
  access: FleetSourceClaimAccess,
  path: string
): FleetSourceFileClaim[] {
  if (value == null || value === "") return [];
  if (typeof value !== "string") {
    reject("invalid_claims", path, `${path} must be JSON text`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    reject("invalid_claims", path, `${path} is not valid JSON`);
  }
  return normalizeClaims(parsed, access, path);
}

function taskAccess(taskType: string): FleetSourceClaimAccess {
  return READ_ONLY_TASK_TYPES.has(taskType.toLowerCase()) ? "read" : "write";
}

function validateDraft(
  draft: FleetSourceDraftPlanInput
): FleetSourceDraftPlanInput {
  if (draft.tasks.length === 0) {
    reject("empty_plan", "tasks", "source produced no tasks");
  }
  if (draft.tasks.length > FLEET_SOURCE_TASK_CAP) {
    reject(
      "task_cap_exceeded",
      "tasks",
      `source exceeds the ${FLEET_SOURCE_TASK_CAP}-task Fleet safety cap`
    );
  }
  const ids = new Set<string>();
  for (const task of draft.tasks) {
    if (ids.has(task.id)) {
      reject(
        "duplicate_task_id",
        `tasks[${task.order}].id`,
        `duplicate task id ${task.id}`
      );
    }
    ids.add(task.id);
    if (task.claimMode === "write" && !task.verifyCommand) {
      reject(
        "missing_verify_command",
        `tasks[${task.order}].verifyCommand`,
        "write tasks require a verification command"
      );
    }
    if (task.claimMode === "read" && task.verifyCommand !== null) {
      reject(
        "invalid_verify_command",
        `tasks[${task.order}].verifyCommand`,
        "read-only tasks cannot execute a verification command"
      );
    }
  }
  const dependencies = new Map<string, string[]>();
  for (const task of draft.tasks) {
    const seen = new Set<string>();
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        reject(
          "unknown_dependency",
          `tasks[${task.order}].dependsOn`,
          `task ${task.id} depends on unknown task ${dependency}`
        );
      }
      if (dependency === task.id) {
        reject(
          "self_dependency",
          `tasks[${task.order}].dependsOn`,
          `task ${task.id} depends on itself`
        );
      }
      if (seen.has(dependency)) {
        reject(
          "duplicate_dependency",
          `tasks[${task.order}].dependsOn`,
          `task ${task.id} repeats dependency ${dependency}`
        );
      }
      seen.add(dependency);
    }
    dependencies.set(task.id, task.dependsOn);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      reject(
        "dependency_cycle",
        "tasks",
        `dependency graph contains a cycle at ${id}`
      );
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return draft;
}

function resultOf(
  build: () => FleetSourceDraftPlanInput
): FleetSourceAdapterResult {
  try {
    return { ok: true, draft: validateDraft(build()) };
  } catch (error) {
    if (error instanceof SourceInputError) {
      return { ok: false, errors: [error.issue] };
    }
    return {
      ok: false,
      errors: [
        {
          code: "unsafe_input",
          path: "source",
          message: "source could not be read safely",
        },
      ],
    };
  }
}

function provenance(
  kind: FleetSourceKind,
  sourceId: unknown,
  sourceName: unknown
): FleetSourceProvenance {
  return {
    kind,
    sourceId: optionalHint(sourceId, "sourceId"),
    sourceName: optionalHint(
      sourceName,
      "sourceName",
      FLEET_PLAN_TASK_TITLE_MAX
    ),
  };
}

function repositoryHints(input: {
  repoId?: unknown;
  projectId?: unknown;
  repoSlug?: unknown;
  workingDirectory?: unknown;
  baseBranch?: unknown;
}): FleetSourceRepositoryHints {
  return {
    repoId: optionalHint(input.repoId, "repository.repoId"),
    projectId: optionalHint(input.projectId, "repository.projectId"),
    repoSlug: optionalHint(input.repoSlug, "repository.repoSlug", 240),
    workingDirectory: pathHint(
      input.workingDirectory,
      "repository.workingDirectory"
    ),
    baseBranch: branchHint(input.baseBranch, "repository.baseBranch"),
  };
}

function parsePipeline(value: unknown): PipelineSpec {
  if (typeof value === "string") {
    if (value.length > 128 * 1024) {
      reject("too_large", "spec", "pipeline spec exceeds 128 KiB");
    }
    const parsed = parsePipelineSpec(value);
    if (!parsed.spec) {
      reject(
        "invalid_pipeline",
        "spec",
        parsed.errors.map((error) => error.message).join("; ") ||
          "pipeline is invalid"
      );
    }
    return parsed.spec;
  }
  const record = asRecord(value, "spec") as unknown as PipelineSpec;
  const validation = validateSpec(record);
  if (!validation.valid) {
    reject(
      "invalid_pipeline",
      "spec",
      validation.errors.map((error) => error.message).join("; ")
    );
  }
  return record;
}

function pipelineDraft(input: {
  spec: unknown;
  kind: "pipeline" | "builder";
  sourceId?: unknown;
  sourceName?: unknown;
  goal?: unknown;
  repoId?: unknown;
  projectId?: unknown;
  baseBranch?: unknown;
  verifyCommand?: unknown;
}): FleetSourceDraftPlanInput {
  const spec = parsePipeline(input.spec);
  if (spec.steps.length > FLEET_SOURCE_TASK_CAP) {
    reject(
      "task_cap_exceeded",
      "spec.steps",
      `source exceeds the ${FLEET_SOURCE_TASK_CAP}-task Fleet safety cap`
    );
  }
  const name = boundedText(spec.name, "spec.name", FLEET_PLAN_TASK_TITLE_MAX, {
    required: true,
  })!;
  const goal = boundedText(input.goal ?? name, "goal", FLEET_PLAN_TEXT_MAX, {
    required: true,
    multiline: true,
  })!;
  const defaultVerifyCommand = verifyCommand(
    input.verifyCommand,
    "verifyCommand",
    true
  );
  const tasks = spec.steps.map((step: PipelineStep, order) => {
    const stepRecord = step as unknown as Record<string, unknown>;
    const id = explicitTaskId(step.id, `spec.steps[${order}].id`);
    const provider = normalizeProvider(
      step.agent,
      `spec.steps[${order}].agent`
    );
    if (!provider) {
      reject(
        "invalid_provider",
        `spec.steps[${order}].agent`,
        "pipeline step requires a provider"
      );
    }
    const taskType = "implement";
    const outputClaims = step.outputFile
      ? normalizeClaims(
          [step.outputFile],
          "write",
          `spec.steps[${order}].outputFile`
        )
      : [];
    return {
      id,
      order,
      title: boundedText(
        step.name ?? step.id,
        `spec.steps[${order}].name`,
        FLEET_PLAN_TASK_TITLE_MAX,
        { required: true }
      )!,
      description: boundedText(
        step.task,
        `spec.steps[${order}].task`,
        FLEET_PLAN_TASK_DESCRIPTION_MAX,
        { required: true, multiline: true }
      ),
      taskType,
      dependsOn: [...(step.dependsOn ?? [])],
      provider,
      model: normalizeModel(step.model, provider, `spec.steps[${order}].model`),
      workingDirectory: pathHint(
        step.workingDirectory ?? spec.workingDirectory,
        `spec.steps[${order}].workingDirectory`
      ),
      baseBranch: branchHint(
        stepRecord.baseBranch ?? input.baseBranch,
        `spec.steps[${order}].baseBranch`
      ),
      claimMode: "write" as const,
      fileClaims: outputClaims,
      acceptanceCriteria: boundedText(
        step.exitCriteria,
        `spec.steps[${order}].exitCriteria`,
        ACCEPTANCE_MAX,
        { multiline: true }
      ),
      verifyCommand: defaultVerifyCommand,
      sourceRef: `${input.kind}:${id}`,
    };
  });
  return {
    name,
    goal,
    tasks,
    provenance: provenance(
      input.kind,
      input.sourceId,
      input.sourceName ?? name
    ),
    repository: repositoryHints({
      repoId: input.repoId,
      projectId: input.projectId,
      workingDirectory: spec.workingDirectory,
      baseBranch: input.baseBranch,
    }),
  };
}

export function adaptFleetTextSource(input: unknown): FleetSourceAdapterResult {
  return resultOf(() => {
    const source = asRecord(input, "source");
    const text = boundedText(source.text, "text", FLEET_PLAN_TEXT_MAX, {
      required: true,
      multiline: true,
    })!;
    // parseFleetPlanText is the existing Fleet Markdown parser. Preflight all
    // claim-shaped annotations because that parser intentionally truncates for
    // interactive use, while an import boundary must reject oversize claims.
    const rawClaims: string[] = [];
    for (const match of text.matchAll(/`([^`]+)`/g)) {
      if (
        match[1] &&
        (/[\\/]/.test(match[1]) || /\.[a-z0-9]{1,8}$/i.test(match[1]))
      ) {
        rawClaims.push(match[1]);
      }
    }
    for (const match of text.matchAll(/\[(?:files?|claims?):\s*([^\]]+)\]/gi)) {
      rawClaims.push(...(match[1] ?? "").split(","));
    }
    normalizeClaims(rawClaims, "write", "text.fileClaims");

    const parsed = parseFleetPlanText(text);
    if ("error" in parsed) reject("invalid_text_plan", "text", parsed.error);
    if (parsed.tasks.length > FLEET_SOURCE_TASK_CAP) {
      reject(
        "task_cap_exceeded",
        "text",
        `source exceeds the ${FLEET_SOURCE_TASK_CAP}-task Fleet safety cap`
      );
    }
    const titles = parsed.tasks.map((task) => task.title);
    const ids = stableGeneratedIds(titles);
    const provider = normalizeProvider(source.provider, "provider");
    const model = normalizeModel(source.model, provider, "model");
    const requestedClaimMode = source.claimMode;
    if (
      requestedClaimMode != null &&
      requestedClaimMode !== "read" &&
      requestedClaimMode !== "write"
    ) {
      reject(
        "invalid_claim_mode",
        "claimMode",
        "claimMode must be read or write"
      );
    }
    const defaultVerifyCommand = verifyCommand(source.verifyCommand);
    const tasks: FleetSourceDraftTask[] = parsed.tasks.map((task, order) => {
      const claimMode =
        (requestedClaimMode as FleetSourceClaimAccess | undefined) ??
        taskAccess(task.taskType);
      return {
        id: ids[order],
        order,
        title: task.title,
        description: task.description,
        taskType: task.taskType,
        dependsOn: task.parentIndex == null ? [] : [ids[task.parentIndex]],
        provider,
        model,
        workingDirectory: pathHint(source.workingDirectory, "workingDirectory"),
        baseBranch: branchHint(source.baseBranch, "baseBranch"),
        claimMode,
        fileClaims: normalizeClaims(
          task.fileClaims,
          claimMode,
          `tasks[${order}].fileClaims`
        ),
        acceptanceCriteria: null,
        verifyCommand: claimMode === "write" ? defaultVerifyCommand : null,
        sourceRef: `text:${order + 1}`,
      };
    });
    const name =
      boundedText(source.name, "name", FLEET_PLAN_TASK_TITLE_MAX) ??
      tasks[0]?.title ??
      "Fleet plan";
    return {
      name,
      goal: text,
      tasks,
      provenance: provenance("text", source.sourceId, name),
      repository: repositoryHints({
        repoId: source.repoId,
        projectId: source.projectId,
        workingDirectory: source.workingDirectory,
        baseBranch: source.baseBranch,
      }),
    };
  });
}

export function adaptFleetPipelineSource(
  input: unknown
): FleetSourceAdapterResult {
  return resultOf(() => {
    const source = asRecord(input, "source");
    return pipelineDraft({
      spec: source.spec,
      kind: "pipeline",
      sourceId: source.sourceId,
      goal: source.goal,
      repoId: source.repoId,
      projectId: source.projectId,
      baseBranch: source.baseBranch,
      verifyCommand: source.verifyCommand,
    });
  });
}

function isSavedWorkflow(value: Record<string, unknown>): boolean {
  return "doc" in value;
}

export function adaptFleetBuilderSource(
  input: unknown
): FleetSourceAdapterResult {
  return resultOf(() => {
    const source = asRecord(input, "source");
    const workflow = asRecord(source.workflow, "workflow");
    const saved = isSavedWorkflow(workflow);
    const doc = asRecord(
      saved ? workflow.doc : workflow,
      "workflow.doc"
    ) as unknown as BuilderDoc;
    if (!Array.isArray(doc.nodes)) {
      reject(
        "invalid_builder",
        "workflow.doc.nodes",
        "builder nodes must be an array"
      );
    }
    const spec = docToSpec(doc);
    return pipelineDraft({
      spec,
      kind: "builder",
      sourceId: source.sourceId ?? (saved ? workflow.id : null),
      sourceName: saved ? workflow.name : doc.name,
      goal: source.goal,
      repoId: source.repoId,
      projectId: doc.projectId,
      baseBranch: source.baseBranch,
      verifyCommand: source.verifyCommand,
    });
  });
}

function dispatchRepoContext(source: Record<string, unknown>) {
  const repo = source.repo == null ? null : asRecord(source.repo, "repo");
  const provider = normalizeProvider(
    source.provider ?? repo?.agent_type,
    "provider"
  );
  const model = normalizeModel(
    source.model ?? repo?.default_model,
    provider,
    "model"
  );
  const repository = repositoryHints({
    repoId: repo?.id,
    projectId: repo?.project_id,
    repoSlug: repo?.repo_slug,
    workingDirectory: repo?.repo_path,
    baseBranch: repo?.base_branch,
  });
  const defaultVerifyCommand = verifyCommand(
    source.verifyCommand ?? repo?.verify_command,
    "verifyCommand",
    true
  );
  return { provider, model, repository, defaultVerifyCommand };
}

function dependencyIndexes(value: unknown, taskCount: number): number[][] {
  if (value == null) return Array.from({ length: taskCount }, () => []);
  if (!Array.isArray(value) || value.length > taskCount) {
    reject(
      "invalid_dependencies",
      "dependencies",
      "dependencies must align with tasks"
    );
  }
  return Array.from({ length: taskCount }, (_, taskIndex) => {
    const raw = value[taskIndex];
    if (raw == null) return [];
    if (!Array.isArray(raw)) {
      reject(
        "invalid_dependencies",
        `dependencies[${taskIndex}]`,
        "dependency indexes must be an array"
      );
    }
    return raw.map((dependency, dependencyIndex) => {
      if (
        !Number.isInteger(dependency) ||
        dependency < 0 ||
        dependency >= taskCount
      ) {
        reject(
          "unknown_dependency",
          `dependencies[${taskIndex}][${dependencyIndex}]`,
          "dependency index is outside the task list"
        );
      }
      return dependency as number;
    });
  });
}

export function adaptFleetDispatchPlannerSource(
  input: unknown
): FleetSourceAdapterResult {
  return resultOf(() => {
    const source = asRecord(input, "source");
    if (!Array.isArray(source.tasks) || source.tasks.length === 0) {
      reject("empty_plan", "tasks", "dispatch planner source requires tasks");
    }
    if (source.tasks.length > FLEET_SOURCE_TASK_CAP) {
      reject(
        "task_cap_exceeded",
        "tasks",
        `source exceeds the ${FLEET_SOURCE_TASK_CAP}-task Fleet safety cap`
      );
    }
    const records = source.tasks.map((task, index) =>
      asRecord(task, `tasks[${index}]`)
    );
    const titles = records.map((task, index) =>
      boundedText(
        task.title,
        `tasks[${index}].title`,
        FLEET_PLAN_TASK_TITLE_MAX,
        {
          required: true,
        }
      )!
    );
    const ids = stableGeneratedIds(titles);
    const dependencies = dependencyIndexes(source.dependencies, records.length);
    const context = dispatchRepoContext(source);
    const tasks: FleetSourceDraftTask[] = records.map((task, order) => ({
      id: ids[order],
      order,
      title: titles[order],
      description: boundedText(
        task.body,
        `tasks[${order}].body`,
        FLEET_PLAN_TASK_DESCRIPTION_MAX,
        { multiline: true }
      ),
      taskType: "implement",
      dependsOn: dependencies[order].map((index) => ids[index]),
      provider: context.provider,
      model: context.model,
      workingDirectory: context.repository.workingDirectory,
      baseBranch: context.repository.baseBranch,
      claimMode: "write",
      fileClaims: normalizeClaims(
        task.claims,
        "write",
        `tasks[${order}].claims`
      ),
      acceptanceCriteria: null,
      verifyCommand: context.defaultVerifyCommand,
      sourceRef: `dispatch-planner:${order + 1}`,
    }));
    for (const task of tasks) {
      if (task.fileClaims.length === 0) {
        reject(
          "missing_write_claim",
          `tasks[${task.order}].claims`,
          "dispatch planner write task requires a file claim"
        );
      }
    }
    const name =
      boundedText(source.name, "name", FLEET_PLAN_TASK_TITLE_MAX) ??
      "Dispatch planner import";
    return {
      name,
      goal:
        boundedText(source.goal, "goal", FLEET_PLAN_TEXT_MAX, {
          multiline: true,
        }) ?? `Promote dispatch plan: ${name}`,
      tasks,
      provenance: provenance("dispatch_planner", source.sourceId, name),
      repository: context.repository,
    };
  });
}

function issueDependencies(
  value: unknown,
  rawIds: string[],
  normalizedIds: string[]
): string[][] {
  if (value == null) return rawIds.map(() => []);
  const record = asRecord(value, "dependencies");
  for (const key of Object.keys(record)) {
    if (!rawIds.includes(key)) {
      reject(
        "unknown_dependency_task",
        `dependencies.${key}`,
        "dependency map names an unknown issue"
      );
    }
  }
  return rawIds.map((rawId, taskIndex) => {
    const dependencies = record[rawId];
    if (dependencies == null) return [];
    if (!Array.isArray(dependencies)) {
      reject(
        "invalid_dependencies",
        `dependencies.${rawId}`,
        "issue dependencies must be an array"
      );
    }
    return dependencies.map((dependency, dependencyIndex) => {
      if (typeof dependency !== "string") {
        reject(
          "invalid_dependencies",
          `dependencies.${rawId}[${dependencyIndex}]`,
          "issue dependency must be a dispatch row id"
        );
      }
      const index = rawIds.indexOf(dependency);
      if (index < 0) {
        reject(
          "unknown_dependency",
          `dependencies.${rawId}[${dependencyIndex}]`,
          `unknown dispatch dependency ${dependency}`
        );
      }
      return normalizedIds[index] ?? normalizedIds[taskIndex];
    });
  });
}

export function adaptFleetDispatchIssueSource(
  input: unknown
): FleetSourceAdapterResult {
  return resultOf(() => {
    const source = asRecord(input, "source");
    if (!Array.isArray(source.issues) || source.issues.length === 0) {
      reject("empty_plan", "issues", "dispatch issue source requires issues");
    }
    if (source.issues.length > FLEET_SOURCE_TASK_CAP) {
      reject(
        "task_cap_exceeded",
        "issues",
        `source exceeds the ${FLEET_SOURCE_TASK_CAP}-task Fleet safety cap`
      );
    }
    const issues = source.issues.map((issue, index) =>
      asRecord(issue, `issues[${index}]`)
    );
    const rawIds = issues.map((issue, index) =>
      boundedText(issue.id, `issues[${index}].id`, SOURCE_REF_MAX, {
        required: true,
      })!
    );
    if (new Set(rawIds).size !== rawIds.length) {
      reject(
        "duplicate_source_id",
        "issues",
        "dispatch issue ids must be unique"
      );
    }
    const normalizedIds = stableGeneratedIds(
      issues.map((issue, index) => {
        const number = Number.isInteger(issue.issue_number)
          ? String(issue.issue_number)
          : String(index + 1);
        return `issue-${number}-${rawIds[index]}`;
      })
    );
    const dependencies = issueDependencies(
      source.dependencies,
      rawIds,
      normalizedIds
    );
    const context = dispatchRepoContext(source);
    const tasks: FleetSourceDraftTask[] = issues.map((issue, order) => {
      const issueNumber = Number.isInteger(issue.issue_number)
        ? (issue.issue_number as number)
        : null;
      const title =
        boundedText(
          issue.issue_title,
          `issues[${order}].issue_title`,
          FLEET_PLAN_TASK_TITLE_MAX
        ) ??
        (issueNumber != null && issueNumber > 0
          ? `Issue #${issueNumber}`
          : null);
      if (!title) {
        reject(
          "required",
          `issues[${order}].issue_title`,
          "local dispatch task requires a title"
        );
      }
      const body = boundedText(
        issue.task_body,
        `issues[${order}].task_body`,
        FLEET_PLAN_TASK_DESCRIPTION_MAX,
        { multiline: true }
      );
      const url = optionalHint(
        issue.issue_url,
        `issues[${order}].issue_url`,
        2_048
      );
      return {
        id: normalizedIds[order],
        order,
        title,
        description: body ?? url,
        taskType: "implement",
        dependsOn: dependencies[order],
        provider: context.provider,
        model: context.model,
        workingDirectory: context.repository.workingDirectory,
        baseBranch: context.repository.baseBranch,
        claimMode: "write" as const,
        fileClaims: claimsFromJson(
          issue.file_claims,
          "write",
          `issues[${order}].file_claims`
        ),
        acceptanceCriteria: null,
        verifyCommand: context.defaultVerifyCommand,
        sourceRef: `dispatch-issue:${rawIds[order]}`,
        sourceIssueId: rawIds[order],
        sourceIssueNumber: issueNumber,
      };
    });
    const name =
      boundedText(source.name, "name", FLEET_PLAN_TASK_TITLE_MAX) ??
      (tasks.length === 1 ? tasks[0].title : "Dispatch issue import");
    return {
      name,
      goal:
        boundedText(source.goal, "goal", FLEET_PLAN_TEXT_MAX, {
          multiline: true,
        }) ??
        `Promote ${tasks.length} dispatch task${tasks.length === 1 ? "" : "s"}: ${name}`,
      tasks,
      provenance: provenance("dispatch_issue", source.sourceId, name),
      repository: context.repository,
    };
  });
}

/** Explicit dispatcher only: importing never writes rows or migrates a live run. */
export function adaptFleetSource(input: unknown): FleetSourceAdapterResult {
  try {
    const source = asRecord(input, "source");
    switch (source.kind) {
      case "text":
        return adaptFleetTextSource(source);
      case "pipeline":
        return adaptFleetPipelineSource(source);
      case "builder":
        return adaptFleetBuilderSource(source);
      case "dispatch_planner":
        return adaptFleetDispatchPlannerSource(source);
      case "dispatch_issue":
        return adaptFleetDispatchIssueSource(source);
      default:
        return {
          ok: false,
          errors: [
            {
              code: "unknown_source",
              path: "kind",
              message: "kind is not a supported explicit Fleet source",
            },
          ],
        };
    }
  } catch (error) {
    if (error instanceof SourceInputError) {
      return { ok: false, errors: [error.issue] };
    }
    return {
      ok: false,
      errors: [
        {
          code: "unsafe_input",
          path: "source",
          message: "source could not be read safely",
        },
      ],
    };
  }
}
