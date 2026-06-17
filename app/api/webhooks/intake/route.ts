/**
 * POST /api/webhooks/intake
 *
 * Public webhook receiver. Accepts two wire formats:
 *
 *   Native Stoa:
 *     Header: X-Stoa-Signature: <hmac-sha256-hex>
 *     Body:   { "event": "task", "repo": "<id|slug>", "title": "...", "body"?: "...", "labels"?: [] }
 *     → inserts source='webhook' dispatch row
 *
 *   GitHub Issues (opened):
 *     Header: X-Hub-Signature-256: sha256=<hex>
 *     Header: X-GitHub-Event: issues
 *     Body:   standard GitHub issues webhook payload (action="opened")
 *     → inserts source='github' dispatch row via upsertDispatchCandidate
 *
 * Security:
 *   - Raw body is read as text before JSON parsing (required for correct HMAC).
 *   - Body is capped at 64 KB before HMAC to prevent DoS via large payloads.
 *   - STOA_WEBHOOK_SECRET must be set; 503 if absent (fail-closed).
 *   - Invalid signature → 401.
 *   - Rate limiting via checkRateLimit (60 req/60 s per IP).
 *   - All user-supplied fields are validated before touching the DB.
 *   - No shell exec, no path operations.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb, queries } from "@/lib/db";
import { checkRateLimit } from "@/lib/api-security";
import {
  getWebhookSecret,
  verifyStoaSignature,
  verifyGitHubSignature,
} from "@/lib/webhooks/verify";
import { parseStoaWebhook, parseGitHubWebhook } from "@/lib/webhooks/parse";
import type { DispatchRepo } from "@/lib/dispatch/types";

const MAX_BODY_BYTES = 64 * 1024; // 64 KB

export async function POST(request: NextRequest) {
  // 1. Rate limit — applied before any crypto work.
  const rl = checkRateLimit(request);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfter ?? 60) },
      }
    );
  }

  // 2. Read raw body as text BEFORE parsing JSON — HMAC must be over the exact bytes.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json(
      { error: "Failed to read request body" },
      { status: 400 }
    );
  }

  // 3. Enforce body size cap before any crypto work (DoS guard).
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "Request body too large" },
      { status: 413 }
    );
  }

  // 4. Require secret; fail closed if not configured.
  const secret = getWebhookSecret();
  if (!secret) {
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 503 }
    );
  }

  // 5. Detect source and verify signature.
  const githubEvent = request.headers.get("x-github-event");
  const hubSig = request.headers.get("x-hub-signature-256");
  const stoaSig = request.headers.get("x-stoa-signature");

  const isGitHub = Boolean(githubEvent);

  if (isGitHub) {
    if (!hubSig || !verifyGitHubSignature(rawBody, hubSig, secret)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } else {
    if (!stoaSig || !verifyStoaSignature(rawBody, stoaSig, secret)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  // 6. Parse JSON payload.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // 7. Normalise payload to a task descriptor.
  const task = isGitHub
    ? parseGitHubWebhook(parsed, githubEvent!)
    : parseStoaWebhook(parsed);

  if (task === null) {
    // For GitHub, an unrecognised event/action is a 200 ack (not an error).
    if (isGitHub) {
      return NextResponse.json({ ok: true, ignored: true });
    }
    return NextResponse.json(
      { error: "Invalid or unsupported payload" },
      { status: 400 }
    );
  }

  // 8. Resolve the target dispatch repo from the task.repo field.
  const db = getDb();
  let repo: DispatchRepo | undefined;

  // Try direct id lookup first (fast path for native events that use the UUID),
  // then fall back to slug lookup for "owner/repo" from GitHub events.
  repo =
    (queries.getDispatchRepo(db).get(task.repo) as DispatchRepo | undefined) ??
    (queries.getDispatchRepoBySlug(db).get(task.repo) as
      | DispatchRepo
      | undefined);

  if (!repo) {
    return NextResponse.json({ error: "Unknown repo" }, { status: 404 });
  }

  // 9. Insert the dispatch row.
  const id = randomUUID();
  const nowIso = new Date().toISOString();

  try {
    if (isGitHub) {
      // GitHub issues: use the idempotent upsert (dedupes on repo_id + issue_number).
      // issueNumber is validated > 0 by parseGitHubWebhook; null path === ignored above.
      queries
        .upsertDispatchCandidate(db)
        .run(
          id,
          repo.id,
          task.issueNumber!,
          task.title,
          task.issueUrl ?? null,
          task.issueCreatedAt ?? nowIso
        );
    } else {
      // Native Stoa webhook: source='webhook', issue_number 0 (like a local task),
      // body in task_body.
      queries
        .insertWebhookTask(db)
        .run(id, repo.id, task.title, task.body ?? null, nowIso);
    }
  } catch (err) {
    console.error("[webhook-intake] DB insert failed:", err);
    return NextResponse.json(
      { error: "Failed to record task" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, issueId: id });
}
