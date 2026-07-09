export interface ParsedFleetPlanTask {
  title: string;
  description: string | null;
  taskType: string;
  parentIndex: number | null;
  sortOrder: number;
  fileClaims: string[];
}

export const FLEET_PLAN_TEXT_MAX = 24000;
export const FLEET_PLAN_TASK_MAX = 80;
export const FLEET_PLAN_TASK_TITLE_MAX = 160;
export const FLEET_PLAN_TASK_DESCRIPTION_MAX = 4000;
export const FLEET_PLAN_FILE_CLAIMS_MAX = 30;
export const FLEET_PLAN_FILE_CLAIM_MAX = 240;

interface DraftTask {
  indent: number;
  title: string;
  description: string[];
  taskType: string;
  fileClaims: string[];
}

interface ParsedLine {
  indent: number;
  text: string;
  taskType: string;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function capText(value: string, max: number): string {
  return value.trim().replace(/\s+/g, " ").slice(0, max);
}

function normalizeMultiline(value: string, max: number): string {
  return value.trim().replace(/\r\n?/g, "\n").slice(0, max);
}

function uniqueCapped(values: string[]): string[] {
  const seen = new Set<string>();
  const claims: string[] = [];
  for (const value of values) {
    const claim = value.trim().slice(0, FLEET_PLAN_FILE_CLAIM_MAX);
    if (!claim || seen.has(claim)) continue;
    seen.add(claim);
    claims.push(claim);
    if (claims.length >= FLEET_PLAN_FILE_CLAIMS_MAX) break;
  }
  return claims;
}

function parseFileClaims(text: string): string[] {
  const claims: string[] = [];
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const value = match[1]?.trim();
    if (!value) continue;
    if (/[\\/]/.test(value) || /\.[a-z0-9]{1,8}$/i.test(value)) {
      claims.push(value);
    }
  }

  const bracketMatch = text.match(/\[(?:files?|claims?):\s*([^\]]+)\]/i);
  if (bracketMatch?.[1]) {
    claims.push(
      ...bracketMatch[1]
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    );
  }

  return uniqueCapped(claims);
}

function splitTitleDescription(text: string): {
  title: string;
  description: string | null;
} {
  const cleaned = text.replace(/\[(?:files?|claims?):[^\]]+\]/gi, "").trim();
  const separator = cleaned.match(/(?:\s+--\s+|\s+-\s+|:\s+)/);
  if (!separator || separator.index == null) {
    return {
      title: capText(cleaned, FLEET_PLAN_TASK_TITLE_MAX),
      description: null,
    };
  }

  const title = capText(
    cleaned.slice(0, separator.index),
    FLEET_PLAN_TASK_TITLE_MAX
  );
  const description = capText(
    cleaned.slice(separator.index + separator[0].length),
    FLEET_PLAN_TASK_DESCRIPTION_MAX
  );
  return { title, description: description || null };
}

function parseTaskLine(line: string): ParsedLine | null {
  const bullet = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/);
  if (bullet?.[2]) {
    return {
      indent: bullet[1].replace(/\t/g, "  ").length,
      text: bullet[2],
      taskType: "task",
    };
  }

  const heading = line.match(/^(\s*)#{2,6}\s+(.+)$/);
  if (heading?.[2]) {
    return {
      indent: heading[1].replace(/\t/g, "  ").length,
      text: heading[2],
      taskType: "milestone",
    };
  }

  return null;
}

function pushDraftTask(tasks: DraftTask[], parsed: ParsedLine): void {
  if (tasks.length >= FLEET_PLAN_TASK_MAX) return;
  const { title, description } = splitTitleDescription(parsed.text);
  if (!title) return;
  tasks.push({
    indent: parsed.indent,
    title,
    description: description ? [description] : [],
    taskType: parsed.taskType,
    fileClaims: parseFileClaims(parsed.text),
  });
}

function parseStructuredTasks(text: string): DraftTask[] {
  const tasks: DraftTask[] = [];
  for (const rawLine of text.split("\n")) {
    const parsed = parseTaskLine(rawLine);
    if (parsed) {
      pushDraftTask(tasks, parsed);
      continue;
    }

    const continuation = rawLine.trim();
    if (continuation && tasks.length > 0) {
      const current = tasks[tasks.length - 1];
      current.description.push(continuation);
      current.fileClaims = uniqueCapped([
        ...current.fileClaims,
        ...parseFileClaims(continuation),
      ]);
    }
  }
  return tasks;
}

function parseFallbackTasks(text: string): DraftTask[] {
  const chunks = text
    .split(/\n\s*\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, FLEET_PLAN_TASK_MAX);

  const source = chunks.length ? chunks : [text];
  return source.map((chunk) => {
    const firstSentence =
      chunk.match(/^([\s\S]{1,180}?)(?:[.!?]\s|$)/)?.[1] ?? chunk;
    const title =
      capText(firstSentence, FLEET_PLAN_TASK_TITLE_MAX) || "Review goal";
    return {
      indent: 0,
      title,
      description: [chunk],
      taskType: "task",
      fileClaims: parseFileClaims(chunk),
    };
  });
}

function parentIndexFor(tasks: DraftTask[], index: number): number | null {
  const indent = tasks[index].indent;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (tasks[cursor].indent < indent) return cursor;
  }
  return null;
}

function toParsedTasks(tasks: DraftTask[]): ParsedFleetPlanTask[] {
  return tasks.map((task, index) => ({
    title: task.title,
    description:
      capText(task.description.join("\n"), FLEET_PLAN_TASK_DESCRIPTION_MAX) ||
      null,
    taskType: task.taskType,
    parentIndex: parentIndexFor(tasks, index),
    sortOrder: index,
    fileClaims: uniqueCapped(task.fileClaims),
  }));
}

export function parseFleetPlanText(
  input: unknown
): { tasks: ParsedFleetPlanTask[]; planText: string } | { error: string } {
  const planText = normalizeMultiline(textValue(input), FLEET_PLAN_TEXT_MAX);
  if (!planText) return { error: "planText is required" };

  const structured = parseStructuredTasks(planText);
  const tasks = toParsedTasks(
    structured.length > 0 ? structured : parseFallbackTasks(planText)
  );
  if (tasks.length === 0) return { error: "plan produced no tasks" };
  return { tasks, planText };
}

export function canonicalFleetPlanTasks(tasks: ParsedFleetPlanTask[]) {
  return tasks.map((task) => ({
    title: task.title,
    description: task.description ?? "",
    taskType: task.taskType,
    parentIndex: task.parentIndex,
    sortOrder: task.sortOrder,
    fileClaims: [...task.fileClaims].sort(),
  }));
}
