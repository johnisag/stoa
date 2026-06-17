/**
 * Webhook payload parsers.
 *
 * Each function validates the shape of the incoming JSON and returns a
 * normalised task descriptor, or null if the payload should be ignored
 * (unknown event type, unrecognised action, etc.).
 */

const TITLE_MAX = 500;
const BODY_MAX = 10_000;

export interface ParsedWebhookTask {
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
  /** GitHub-only: the real issue number (always > 0). Used for dedup. */
  issueNumber?: number;
  /** GitHub-only: the issue HTML URL. */
  issueUrl?: string;
  /** GitHub-only: the issue creation ISO timestamp. */
  issueCreatedAt?: string;
}

/**
 * Parse a native Stoa webhook payload.
 *
 * Expected shape:
 *   { "event": "task", "repo": "<id or slug>", "title": "...", "body"?: "...", "labels"?: [] }
 *
 * Returns null for any shape that doesn't match (wrong event, missing fields,
 * values that fail length validation).
 */
export function parseStoaWebhook(raw: unknown): ParsedWebhookTask | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  if (obj["event"] !== "task") return null;

  const repo = typeof obj["repo"] === "string" ? obj["repo"].trim() : "";
  const title = typeof obj["title"] === "string" ? obj["title"].trim() : "";

  if (!repo || !title) return null;
  if (title.length > TITLE_MAX) return null;

  const body = typeof obj["body"] === "string" ? obj["body"] : undefined;
  if (body !== undefined && body.length > BODY_MAX) return null;

  const rawLabels = Array.isArray(obj["labels"])
    ? (obj["labels"] as unknown[])
        .filter((l): l is string => typeof l === "string")
        .map((l) => l.slice(0, 100))
        .slice(0, 20)
    : undefined;
  const labels = rawLabels && rawLabels.length > 0 ? rawLabels : undefined;

  return { repo, title, body, labels };
}

/**
 * Parse a GitHub webhook payload.
 *
 * We handle:
 *   X-GitHub-Event: issues   with   action: "opened"
 *
 * Returns null for all other events/actions so the receiver can respond 200
 * (acknowledging receipt) without inserting anything. Returns null if the
 * issue number is missing or non-positive (required for dedup).
 */
export function parseGitHubWebhook(
  raw: unknown,
  event: string
): ParsedWebhookTask | null {
  if (event !== "issues") return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  if (obj["action"] !== "opened") return null;

  const issue = obj["issue"];
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return null;
  const issueObj = issue as Record<string, unknown>;

  const repository = obj["repository"];
  if (
    !repository ||
    typeof repository !== "object" ||
    Array.isArray(repository)
  )
    return null;
  const repoObj = repository as Record<string, unknown>;

  const repo =
    typeof repoObj["full_name"] === "string" ? repoObj["full_name"].trim() : "";
  const title =
    typeof issueObj["title"] === "string" ? issueObj["title"].trim() : "";

  if (!repo || !title) return null;
  if (title.length > TITLE_MAX) return null;

  const body =
    typeof issueObj["body"] === "string" ? issueObj["body"] : undefined;
  if (body !== undefined && body.length > BODY_MAX) return null;

  const issueNumber =
    typeof issueObj["number"] === "number" ? issueObj["number"] : 0;
  // A non-positive issue number means dedup would fail (the unique index only
  // covers issue_number > 0). Reject rather than silently creating duplicates.
  if (issueNumber <= 0) return null;

  const rawUrl =
    typeof issueObj["html_url"] === "string" ? issueObj["html_url"] : undefined;
  const issueUrl =
    rawUrl && rawUrl.startsWith("https://github.com/") ? rawUrl : undefined;
  const rawCreatedAt =
    typeof issueObj["created_at"] === "string"
      ? issueObj["created_at"]
      : undefined;
  const issueCreatedAt =
    rawCreatedAt && !isNaN(new Date(rawCreatedAt).getTime())
      ? rawCreatedAt
      : undefined;

  return { repo, title, body, issueNumber, issueUrl, issueCreatedAt };
}
