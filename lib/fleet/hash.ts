import { createHash } from "crypto";
import type { FleetTaskRow } from "./types";
import { canonicalFleetPlanTasks, type ParsedFleetPlanTask } from "./plan";

function parseFileClaims(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseFileClaimsStrict(
  value: string
): { claims: string[] } | { error: string } {
  try {
    const parsed = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((entry): entry is string => typeof entry === "string")
    ) {
      return { error: "plan graph has invalid file claims" };
    }
    return { claims: parsed };
  } catch {
    return { error: "plan graph has invalid file claims" };
  }
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function hashParsedFleetPlanTasks(tasks: ParsedFleetPlanTask[]): string {
  return stableHash(canonicalFleetPlanTasks(tasks));
}

export function hashFleetTaskRows(rows: FleetTaskRow[]): string {
  const ordered = [...rows].sort((a, b) => a.sort_order - b.sort_order);
  const indexById = new Map(ordered.map((task, index) => [task.id, index]));
  const canonical = ordered.map((task, index) => ({
    title: task.title,
    description: task.description ?? "",
    taskType: task.task_type,
    parentIndex:
      task.parent_task_id == null
        ? null
        : (indexById.get(task.parent_task_id) ?? null),
    sortOrder: index,
    fileClaims: parseFileClaims(task.file_claims_json).sort(),
  }));
  return stableHash(canonical);
}

export function validateFleetTaskRowsForApproval(
  rows: FleetTaskRow[]
): { hash: string } | { error: string } {
  const ordered = [...rows].sort((a, b) => a.sort_order - b.sort_order);
  const indexById = new Map(ordered.map((task, index) => [task.id, index]));
  const canonical = [];

  for (const [index, task] of ordered.entries()) {
    if (task.status !== "draft") {
      return { error: "plan graph has non-draft tasks" };
    }
    let parentIndex: number | null = null;
    if (task.parent_task_id != null) {
      const parent = indexById.get(task.parent_task_id);
      if (parent == null) return { error: "plan graph has invalid parents" };
      parentIndex = parent;
    }
    const claims = parseFileClaimsStrict(task.file_claims_json);
    if ("error" in claims) return claims;

    canonical.push({
      title: task.title,
      description: task.description ?? "",
      taskType: task.task_type,
      parentIndex,
      sortOrder: index,
      fileClaims: claims.claims.sort(),
    });
  }

  return { hash: stableHash(canonical) };
}
