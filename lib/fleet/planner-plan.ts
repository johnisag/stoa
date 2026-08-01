import { normalizeFleetClaims } from "./conflicts";
import { FLEET_PLAN_FILE_CLAIM_MAX, FLEET_PLAN_FILE_CLAIMS_MAX } from "./plan";

const PLAN_BEGIN = "STOA_FLEET_PLAN_BEGIN";
const PLAN_END = "STOA_FLEET_PLAN_END";

export const FLEET_PLANNER_TASK_CAP_DEFAULT = 8;
export const FLEET_PLANNER_TASK_CAP_MAX = 40;

export interface FleetPlannerTask {
  key: string;
  title: string;
  description: string;
  taskType: string;
  fileClaims: string[];
  dependsOn: string[];
  acceptanceCriteria: string | null;
  verifyCommand: string | null;
  suggestedProvider: string | null;
}

export type FleetPlannerParseResult =
  { ok: true; tasks: FleetPlannerTask[] } | { ok: false; error: string };

function trimmed(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeFleetPlannerTaskCap(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return FLEET_PLANNER_TASK_CAP_DEFAULT;
  return Math.max(1, Math.min(FLEET_PLANNER_TASK_CAP_MAX, parsed));
}

export function buildFleetPlannerPrompt(input: {
  goal: string;
  baseBranch: string;
  taskCap: number;
  availableProviders: string[];
}): string {
  return [
    `[Stoa Fleet] You are the planning agent. Inspect the repository at branch`,
    `"${input.baseBranch}" and decompose the goal into at most ${input.taskCap} safe,`,
    `reviewable tasks. Plan only: do not modify project files, commit, push, or`,
    `open a pull request. Your only write is PLAN.md in this worktree.`,
    "",
    "GOAL:",
    input.goal,
    "",
    `Installed providers available for suggestions: ${input.availableProviders.join(", ")}.`,
    `Use stable lowercase keys. Dependencies may only name earlier task keys.`,
    `Use repo-relative forward-slash path prefixes without globs for fileClaims.`,
    `Keep write claims disjoint. Use taskType "explore" or "review" for read-only`,
    `work; otherwise use "implementation", "test", or "docs". Do not invent a`,
    `model. A suggestedProvider is optional and must come from the installed list.`,
    "",
    `Write exactly one JSON object between these marker lines in PLAN.md:`,
    PLAN_BEGIN,
    `{"tasks":[{"key":"api","title":"Implement API","description":"...","taskType":"implementation","fileClaims":["app/api/"],"dependsOn":[],"acceptanceCriteria":"...","verifyCommand":"npm test","suggestedProvider":"codex"}]}`,
    PLAN_END,
  ].join("\n");
}

export function parseFleetPlannerOutput(
  fileText: string,
  taskCap: number
): FleetPlannerParseResult {
  const begin = fileText.lastIndexOf(PLAN_BEGIN);
  if (begin < 0) return { ok: false, error: `missing ${PLAN_BEGIN} marker` };
  const start = begin + PLAN_BEGIN.length;
  const end = fileText.indexOf(PLAN_END, start);
  if (end < 0) return { ok: false, error: `missing ${PLAN_END} marker` };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText.slice(start, end).trim());
  } catch {
    return { ok: false, error: "planner output is not valid JSON" };
  }
  const rawTasks =
    parsed && typeof parsed === "object"
      ? (parsed as { tasks?: unknown }).tasks
      : null;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    return { ok: false, error: "planner output has no tasks" };
  }
  if (rawTasks.length > taskCap) {
    return { ok: false, error: `planner exceeded the ${taskCap}-task cap` };
  }

  const tasks: FleetPlannerTask[] = [];
  const knownKeys = new Set<string>();
  for (const raw of rawTasks) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "planner output contains a malformed task" };
    }
    const record = raw as Record<string, unknown>;
    const key = trimmed(record.key, 64).toLowerCase();
    const title = trimmed(record.title, 160);
    const description = trimmed(record.description, 4000);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(key) || knownKeys.has(key)) {
      return {
        ok: false,
        error: "planner task keys must be unique and stable",
      };
    }
    if (!title || !description) {
      return {
        ok: false,
        error: `planner task ${key || "(unknown)"} is incomplete`,
      };
    }
    const dependsOn = Array.isArray(record.dependsOn)
      ? record.dependsOn.map((value) => trimmed(value, 64).toLowerCase())
      : [];
    if (
      dependsOn.some((dependency) => !knownKeys.has(dependency)) ||
      new Set(dependsOn).size !== dependsOn.length
    ) {
      return {
        ok: false,
        error: `planner task ${key} has a forward or unknown dependency`,
      };
    }
    const taskType = trimmed(record.taskType, 40) || "implementation";
    const readOnly = taskType === "explore" || taskType === "review";
    const rawClaims = Array.isArray(record.fileClaims)
      ? record.fileClaims.filter(
          (value): value is string => typeof value === "string"
        )
      : [];
    if (
      rawClaims.length > FLEET_PLAN_FILE_CLAIMS_MAX ||
      rawClaims.some(
        (claim) =>
          claim.trim().length > FLEET_PLAN_FILE_CLAIM_MAX ||
          /[*?\[\]{}!]/.test(claim)
      )
    ) {
      return {
        ok: false,
        error: `planner task ${key} has unsafe or excessive file claims`,
      };
    }
    const fileClaims = normalizeFleetClaims(rawClaims);
    if (!readOnly && fileClaims.length === 0) {
      return { ok: false, error: `write task ${key} has no valid file claims` };
    }
    knownKeys.add(key);
    tasks.push({
      key,
      title,
      description,
      taskType,
      fileClaims,
      dependsOn,
      acceptanceCriteria: trimmed(record.acceptanceCriteria, 2000) || null,
      verifyCommand: trimmed(record.verifyCommand, 500) || null,
      suggestedProvider: trimmed(record.suggestedProvider, 40) || null,
    });
  }
  return { ok: true, tasks };
}

export function fleetPlannerPlanText(tasks: FleetPlannerTask[]): string {
  return tasks
    .map((task, index) => {
      const claims = task.fileClaims.length
        ? ` [files: ${task.fileClaims.join(", ")}]`
        : "";
      const dependencies = task.dependsOn.length
        ? `\n  Depends on: ${task.dependsOn.join(", ")}`
        : "";
      const acceptance = task.acceptanceCriteria
        ? `\n  Acceptance: ${task.acceptanceCriteria}`
        : "";
      const provider = task.suggestedProvider
        ? `\n  Suggested provider: ${task.suggestedProvider}`
        : "";
      const verify = task.verifyCommand
        ? `\n  Verify: ${task.verifyCommand}`
        : "";
      return `${index + 1}. ${task.title} -- ${task.description}${claims}${dependencies}${acceptance}${verify}${provider}`;
    })
    .join("\n");
}
