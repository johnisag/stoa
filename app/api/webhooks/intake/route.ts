/**
 * POST /api/webhooks/intake
 *
 * Public endpoint — no localhost restriction.  Authentication is entirely via
 * HMAC-SHA256 signature verification (STOA_WEBHOOK_SECRET env var).
 *
 * Supported event sources:
 *   1. Native Stoa events  — X-Stoa-Timestamp: <unix-seconds>
 *                            X-Stoa-Signature: HMAC-SHA256(<timestamp>.<body>, secret)
 *      Body: { event: "task", repo: "<id|slug>", title: "...", body?: "...", labels?: [] }
 *
 *   2. GitHub issue events — X-Hub-Signature-256: sha256=<hex>
 *                            X-GitHub-Event: issues
 *      GitHub `issues.opened` is mapped to a dispatch candidate (source='github').
 *      All other GitHub events return 200 + { ignored: true }.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb, queries } from "@/lib/db";
import { checkWebhookRateLimit } from "@/lib/api-security";
import { getWebhookSecret, verifyStoaSignature, verifyGitHubSignature } from "@/lib/webhooks/verify";
import { parseStoaWebhook, parseGitHubWebhook } from "@/lib/webhooks/parse";
import type { DispatchRepo } from "@/lib/dispatch/types";

/** Maximum body size accepted (1 MB) — guard before HMAC computation. */
const BODY_SIZE_LIMIT = 1_000_000;

/** GitHub issue html_url must start with this prefix to be stored. */
const GITHUB_URL_PREFIX = "https://github.com/";

/** Look up a dispatch repo by UUID id first, then by repo_slug. */
function findRepo(repoRef: string): DispatchRepo | undefined {
  const db = getDb();
  const byId = queries.getDispatchRepo(db).get(repoRef) as
    | DispatchRepo
    | undefined;
  if (byId) return byId;
  return queries.getDispatchRepoBySlug(db).get(repoRef) as
    | DispatchRepo
    | undefined;
}

export async function POST(request: NextRequest) {
  // Rate-limit first — before any expensive work.  Webhook intake uses its own
  // tighter bucket (10/min) separate from the shared UI bucket (60/min).
  const rl = checkWebhookRateLimit(request);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate limit exceeded" },
      {
        status: 429,
        headers: rl.retryAfter
          ? { "Retry-After": String(rl.retryAfter) }
          : undefined,
      }
    );
  }

  // Fail closed: refuse all requests if the secret is not configured.
  const secret = getWebhookSecret();
  if (!secret) {
    return NextResponse.json(
      { error: "webhook secret not configured" },
      { status: 503 }
    );
  }

  // Read the raw body once — needed for signature verification before JSON parse.
  // Guard size before computing HMAC to prevent DoS via huge payloads.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: "could not read body" }, { status: 400 });
  }
  if (rawBody.length > BODY_SIZE_LIMIT) {
    return NextResponse.json({ error: "request body too large" }, { status: 413 });
  }

  // Determine event source from headers.
  const githubEvent = request.headers.get("x-github-event");
  const isGitHub = githubEvent !== null;

  // Verify signature.
  if (isGitHub) {
    const sig = request.headers.get("x-hub-signature-256") ?? "";
    if (!verifyGitHubSignature(rawBody, sig, secret)) {
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  } else {
    const sig = request.headers.get("x-stoa-signature") ?? "";
    const ts = request.headers.get("x-stoa-timestamp") ?? "";
    if (!verifyStoaSignature(rawBody, sig, secret, ts)) {
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  }

  // Parse JSON body.
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    if (isGitHub) {
      // GitHub path.
      const task = parseGitHubWebhook(payload, githubEvent ?? "");
      if (!task) {
        // Unsupported event type or action — acknowledge without inserting.
        return NextResponse.json({ ok: true, ignored: true });
      }

      // Look up repo by full_name (repo_slug in dispatch_repos).
      const repo = findRepo(task.repo);
      if (!repo) {
        // Don't echo the attacker-controlled repo name back — just 404.
        return NextResponse.json({ error: "repo not found" }, { status: 404 });
      }

      // Extract GitHub issue metadata from the raw payload for upsertDispatchCandidate.
      const raw = payload as Record<string, unknown>;
      const issue = raw["issue"] as Record<string, unknown>;

      // Validate issue number — must be a positive 32-bit integer.
      const issueNumber = Number(issue["number"]);
      if (!Number.isInteger(issueNumber) || issueNumber <= 0 || issueNumber > 2_147_483_647) {
        return NextResponse.json({ error: "invalid issue number" }, { status: 400 });
      }

      // Validate html_url — must be a proper github.com HTTPS URL.
      const rawUrl = String(issue["html_url"] ?? "");
      if (!rawUrl.startsWith(GITHUB_URL_PREFIX)) {
        return NextResponse.json({ error: "invalid issue url" }, { status: 400 });
      }
      const issueUrl = rawUrl;

      // Validate created_at — must be a parseable date string.
      const rawCreatedAt = String(issue["created_at"] ?? "");
      const issueCreatedAt =
        rawCreatedAt && !isNaN(Date.parse(rawCreatedAt))
          ? rawCreatedAt
          : new Date().toISOString();

      const id = randomUUID();
      queries
        .upsertDispatchCandidate(getDb())
        .run(id, repo.id, issueNumber, task.title, issueUrl, issueCreatedAt);

      // Retrieve the inserted (or pre-existing) row's id for the response.
      const row = getDb()
        .prepare(
          "SELECT id FROM issue_dispatches WHERE repo_id = ? AND issue_number = ?"
        )
        .get(repo.id, issueNumber) as { id: string } | undefined;

      return NextResponse.json({ ok: true, issueId: row?.id ?? id });
    } else {
      // Native Stoa path.
      const task = parseStoaWebhook(payload);
      if (!task) {
        return NextResponse.json(
          { error: "invalid or unsupported webhook payload" },
          { status: 400 }
        );
      }

      const repo = findRepo(task.repo);
      if (!repo) {
        return NextResponse.json({ error: "repo not found" }, { status: 404 });
      }

      const id = randomUUID();
      queries
        .insertWebhookTask(getDb())
        .run(id, repo.id, task.title, task.body ?? null, new Date().toISOString());

      return NextResponse.json({ ok: true, issueId: id });
    }
  } catch (err) {
    console.error("webhook intake error:", err);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
