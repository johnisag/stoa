import { createHash, timingSafeEqual } from "crypto";
import { isSafeModel } from "@/lib/model-catalog";
import { normalizeFleetClaims } from "./conflicts";
import { FLEET_PLAN_FILE_CLAIM_MAX, FLEET_PLAN_FILE_CLAIMS_MAX } from "./plan";
import { parseVerifySteps } from "../verification/runner";

const PLAN_BEGIN = "STOA_FLEET_PLAN_BEGIN";
const PLAN_END = "STOA_FLEET_PLAN_END";
const PLANNER_RESULT_SCHEMA_VERSION = 1;
const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PLANNER_ACCEPTANCE_CRITERIA_MAX = 2_000;
const PLANNER_RISK_NOTES_MAX = 8;
const PLANNER_RISK_TEXT_MAX = 500;
const PLANNER_RISK_MITIGATION_MAX = 1_000;
const PLANNER_SUGGESTED_MODEL_MAX = 160;

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
  riskNotes: FleetPlannerRiskNote[];
  verifyCommand: string | null;
  suggestedProvider: string | null;
  suggestedModel: string | null;
}

export interface FleetPlannerRiskNote {
  severity: "low" | "medium" | "high";
  risk: string;
  mitigation: string;
}

export type FleetPlannerParseResult =
  { ok: true; tasks: FleetPlannerTask[] } | { ok: false; error: string };

export interface FleetPlannerResultIdentity {
  runId: string;
  requestId: string;
  attempt: number;
  baseSha: string;
  nonceHash: string;
}

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
  resultPath: string;
  nonce: string;
  runId: string;
  requestId: string;
  attempt: number;
  baseSha: string;
}): string {
  return [
    `[Stoa Fleet] You are the planning agent. Inspect the repository at branch`,
    `"${input.baseBranch}". This checkout is pinned to exact commit ${input.baseSha}.`,
    `Decompose the goal into at most ${input.taskCap} safe,`,
    `reviewable tasks. Plan only: do not modify project files, commit, push, or`,
    `open a pull request. Do not read or trust a preexisting PLAN.md.`,
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
    `Every write task must include a non-empty verifyCommand. Commands execute as`,
    `direct argv steps: use && only to separate steps and never use shell pipes,`,
    `redirects, substitutions, single quotes, or environment assignments.`,
    "",
    `Write exactly one UTF-8 JSON object to the external Fleet-owned path ${input.resultPath}.`,
    `That external result is your only allowed write. Do not write markdown or prose outside it.`,
    `Copy schemaVersion, nonce, runId, requestId, attempt, and baseSha exactly.`,
    JSON.stringify(
      {
        schemaVersion: PLANNER_RESULT_SCHEMA_VERSION,
        nonce: input.nonce,
        runId: input.runId,
        requestId: input.requestId,
        attempt: input.attempt,
        baseSha: input.baseSha,
        tasks: [
          {
            key: "api",
            title: "Implement API",
            description: "...",
            taskType: "implementation",
            fileClaims: ["app/api/"],
            dependsOn: [],
            acceptanceCriteria: "...",
            riskNotes: [
              {
                severity: "medium",
                risk: "Describe a concrete implementation or rollout risk",
                mitigation:
                  "Describe how the worker or reviewer should contain it",
              },
            ],
            verifyCommand: "npm test",
            suggestedProvider: "codex",
            suggestedModel: null,
          },
        ],
      },
      null,
      2
    ),
  ].join("\n");
}

function hashesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function plannerNonceHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseFleetPlannerTasks(
  rawTasks: unknown,
  taskCap: number
): FleetPlannerParseResult {
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
    const rawAcceptanceCriteria =
      typeof record.acceptanceCriteria === "string"
        ? record.acceptanceCriteria.trim()
        : "";
    if (
      !readOnly &&
      (!rawAcceptanceCriteria ||
        rawAcceptanceCriteria.length > PLANNER_ACCEPTANCE_CRITERIA_MAX)
    ) {
      return {
        ok: false,
        error: `write task ${key} needs bounded acceptance criteria`,
      };
    }
    const rawRiskNotes = record.riskNotes;
    if (
      !Array.isArray(rawRiskNotes) ||
      rawRiskNotes.length > PLANNER_RISK_NOTES_MAX ||
      (!readOnly && rawRiskNotes.length === 0)
    ) {
      return {
        ok: false,
        error: `planner task ${key} needs bounded structured risk notes`,
      };
    }
    const riskNotes: FleetPlannerRiskNote[] = [];
    for (const rawRisk of rawRiskNotes) {
      if (!rawRisk || typeof rawRisk !== "object" || Array.isArray(rawRisk)) {
        return {
          ok: false,
          error: `planner task ${key} has a malformed risk note`,
        };
      }
      const riskRecord = rawRisk as Record<string, unknown>;
      const severity = riskRecord.severity;
      const risk =
        typeof riskRecord.risk === "string" ? riskRecord.risk.trim() : "";
      const mitigation =
        typeof riskRecord.mitigation === "string"
          ? riskRecord.mitigation.trim()
          : "";
      if (
        (severity !== "low" && severity !== "medium" && severity !== "high") ||
        !risk ||
        risk.length > PLANNER_RISK_TEXT_MAX ||
        !mitigation ||
        mitigation.length > PLANNER_RISK_MITIGATION_MAX
      ) {
        return {
          ok: false,
          error: `planner task ${key} has a malformed risk note`,
        };
      }
      riskNotes.push({ severity, risk, mitigation });
    }
    const verifyCommand = trimmed(record.verifyCommand, 500) || null;
    if (!readOnly && !verifyCommand) {
      return {
        ok: false,
        error: `write task ${key} has no verification command`,
      };
    }
    if (verifyCommand && !("steps" in parseVerifySteps(verifyCommand))) {
      return {
        ok: false,
        error: `planner task ${key} has an unsafe verification command`,
      };
    }
    const suggestedProvider = trimmed(record.suggestedProvider, 40) || null;
    const rawSuggestedModel =
      typeof record.suggestedModel === "string"
        ? record.suggestedModel.trim()
        : "";
    if (
      rawSuggestedModel &&
      (!suggestedProvider ||
        rawSuggestedModel.length > PLANNER_SUGGESTED_MODEL_MAX ||
        !isSafeModel(rawSuggestedModel))
    ) {
      return {
        ok: false,
        error: `planner task ${key} has an unsafe model suggestion`,
      };
    }
    knownKeys.add(key);
    tasks.push({
      key,
      title,
      description,
      taskType,
      fileClaims,
      dependsOn,
      acceptanceCriteria: rawAcceptanceCriteria || null,
      riskNotes,
      verifyCommand,
      suggestedProvider,
      suggestedModel: rawSuggestedModel || null,
    });
  }
  return { ok: true, tasks };
}

/** Parse and authenticate one Fleet-owned planner result attempt. */
export function parseFleetPlannerResult(
  text: string,
  expected: FleetPlannerResultIdentity,
  taskCap: number
): FleetPlannerParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "planner result is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "planner result must be an object" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== PLANNER_RESULT_SCHEMA_VERSION) {
    return { ok: false, error: "unsupported planner result schema" };
  }
  const nonce =
    typeof record.nonce === "string" && record.nonce.length <= 128
      ? record.nonce
      : "";
  if (
    !nonce ||
    !/^[0-9a-f]{64}$/.test(expected.nonceHash) ||
    !hashesEqual(plannerNonceHash(nonce), expected.nonceHash)
  ) {
    return { ok: false, error: "planner result nonce does not match" };
  }
  for (const [field, expectedValue] of [
    ["runId", expected.runId],
    ["requestId", expected.requestId],
    ["attempt", expected.attempt],
    ["baseSha", expected.baseSha],
  ] as const) {
    if (record[field] !== expectedValue) {
      return { ok: false, error: `planner result ${field} does not match` };
    }
  }
  if (!FULL_GIT_SHA.test(expected.baseSha)) {
    return { ok: false, error: "planner result base contract is invalid" };
  }
  return parseFleetPlannerTasks(record.tasks, taskCap);
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
  return parseFleetPlannerTasks(rawTasks, taskCap);
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
      const risks = task.riskNotes.length
        ? `\n  Risks: ${JSON.stringify(task.riskNotes)}`
        : "";
      const provider = task.suggestedProvider
        ? `\n  Suggested provider: ${task.suggestedProvider}`
        : "";
      const model = task.suggestedModel
        ? `\n  Suggested model: ${task.suggestedModel}`
        : "";
      const verify = task.verifyCommand
        ? `\n  Verify: ${task.verifyCommand}`
        : "";
      return `${index + 1}. ${task.title} -- ${task.description}${claims}${dependencies}${acceptance}${risks}${verify}${provider}${model}`;
    })
    .join("\n");
}
