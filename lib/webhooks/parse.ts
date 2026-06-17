/**
 * Webhook payload parsers.
 *
 * parseStoaWebhook   — native Stoa `task` events
 * parseGitHubWebhook — GitHub `issues` events (action: opened)
 *
 * Both return a normalised task shape or null if the payload should be ignored.
 */

export interface WebhookTask {
  /** Repo id or slug from the payload. */
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
}

const TITLE_MAX = 500;
const BODY_MAX = 10_000;
const LABELS_MAX = 20;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse a native Stoa webhook payload.
 *
 * Expected shape:
 *   { event: "task", repo: string, title: string, body?: string, labels?: string[] }
 *
 * Returns null for:
 *   - non-object input
 *   - wrong event type
 *   - missing / oversized repo or title
 *   - oversized body
 */
export function parseStoaWebhook(raw: unknown): WebhookTask | null {
  if (!isPlainObject(raw)) return null;
  if (raw["event"] !== "task") return null;

  const repo = raw["repo"];
  const title = raw["title"];

  if (typeof repo !== "string" || !repo) return null;
  if (typeof title !== "string" || !title) return null;
  if (title.length > TITLE_MAX) return null;

  const body = raw["body"];
  if (body !== undefined && body !== null) {
    if (typeof body !== "string") return null;
    if (body.length > BODY_MAX) return null;
  }

  // Filter non-string labels, cap at LABELS_MAX.
  let labels: string[] | undefined;
  const rawLabels = raw["labels"];
  if (Array.isArray(rawLabels)) {
    labels = (rawLabels.filter((l) => typeof l === "string") as string[]).slice(
      0,
      LABELS_MAX
    );
  }

  const task: WebhookTask = { repo, title };
  if (typeof body === "string") task.body = body;
  if (labels) task.labels = labels;
  return task;
}

/**
 * Parse a GitHub webhook payload.
 *
 * Only processes `issues` events with `action: "opened"`.  Every other event
 * type or action returns null (caller should respond 200 + ignored=true).
 */
export function parseGitHubWebhook(
  raw: unknown,
  eventType: string
): WebhookTask | null {
  if (eventType !== "issues") return null;
  if (!isPlainObject(raw)) return null;
  if (raw["action"] !== "opened") return null;

  const issue = raw["issue"];
  const repository = raw["repository"];
  if (!isPlainObject(issue) || !isPlainObject(repository)) return null;

  const title = issue["title"];
  if (typeof title !== "string" || !title) return null;
  if (title.length > TITLE_MAX) return null;

  const repoFullName = repository["full_name"];
  if (typeof repoFullName !== "string" || !repoFullName) return null;

  const task: WebhookTask = { repo: repoFullName, title };
  const body = issue["body"];
  if (typeof body === "string" && body) {
    // Cap at BODY_MAX to match the native path — GitHub issue bodies can be
    // up to 65 536 characters but we store only the first 10 000.
    task.body = body.length > BODY_MAX ? body.slice(0, BODY_MAX) : body;
  }
  return task;
}
