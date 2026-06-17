/**
 * Webhook intake tests — Wave C
 *
 * Covers:
 *  - verifyStoaSignature / verifyGitHubSignature (correct, wrong, missing, length-mismatch)
 *  - parseStoaWebhook / parseGitHubWebhook (valid, ignored events, truncation guards)
 *  - insertWebhookTask (source='webhook', issue_number=0)
 *  - Route-level integration:
 *    - missing STOA_WEBHOOK_SECRET → 503
 *    - invalid signature → 401
 *    - unknown repo → 404
 *    - malformed JSON → 400 (native only)
 *    - native task event → 200 + source='webhook' row
 *    - GitHub issues.opened event → 200 + source='github' row
 *    - GitHub unknown event → 200 + ignored=true, no row inserted
 *    - rate limit → 429
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import Database from "better-sqlite3";
import { createHmac } from "crypto";
import { randomUUID } from "crypto";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db";
import {
  verifyStoaSignature,
  verifyGitHubSignature,
  getWebhookSecret,
} from "@/lib/webhooks/verify";
import { parseStoaWebhook, parseGitHubWebhook } from "@/lib/webhooks/parse";
import type { IssueDispatch } from "@/lib/dispatch/types";

// ---------------------------------------------------------------------------
// Top-level shared state for the integration mocks.
// vi.mock is hoisted to module top, so closures over `let` vars declared in
// describe blocks don't work. Instead we put the DB reference in a mutable
// shared cell that is filled in beforeAll.
// ---------------------------------------------------------------------------

const shared = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
  rateLimitAllowed: true as boolean,
  rateLimitRetryAfter: undefined as number | undefined,
}));

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    getDb: () => shared.db,
    queries: actual.queries,
  };
});

vi.mock("@/lib/api-security", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-security")>(
    "@/lib/api-security"
  );
  return {
    ...actual,
    checkWebhookRateLimit: () => ({
      allowed: shared.rateLimitAllowed,
      retryAfter: shared.rateLimitRetryAfter,
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

/** Current Unix timestamp as a string (seconds). */
function nowTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

/** Sign a body with the native Stoa scheme: HMAC("<ts>.<body>", secret). */
function stoaSign(secret: string, body: string, ts: string): string {
  return hmacHex(secret, `${ts}.${body}`);
}

/** Build a minimal NextRequest-like object for route tests. */
function makeRequest(opts: {
  body: string;
  headers?: Record<string, string>;
}): Request {
  return new Request("http://localhost/api/webhooks/intake", {
    method: "POST",
    body: opts.body,
    headers: { "Content-Type": "application/json", ...opts.headers },
  });
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe("verifyStoaSignature", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ event: "task", repo: "r1", title: "Fix it" });

  it("accepts a correct HMAC-SHA256 hex signature with valid timestamp", () => {
    const ts = nowTs();
    const sig = stoaSign(secret, body, ts);
    expect(verifyStoaSignature(body, sig, secret, ts)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const ts = nowTs();
    const bad = stoaSign(secret, body, ts).replace(/^./, "0");
    expect(verifyStoaSignature(body, bad, secret, ts)).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(verifyStoaSignature(body, "", secret, nowTs())).toBe(false);
  });

  it("rejects when body has been tampered", () => {
    const ts = nowTs();
    const sig = stoaSign(secret, body, ts);
    expect(verifyStoaSignature(body + " ", sig, secret, ts)).toBe(false);
  });

  it("rejects a signature of the wrong length / non-hex (format guard)", () => {
    // short hex — must not throw
    expect(verifyStoaSignature(body, "abc123", secret, nowTs())).toBe(false);
    // 64 chars but non-hex chars
    expect(
      verifyStoaSignature(body, "g".repeat(64), secret, nowTs())
    ).toBe(false);
  });

  it("rejects a stale timestamp (> 5 min ago)", () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 400);
    const sig = stoaSign(secret, body, staleTs);
    expect(verifyStoaSignature(body, sig, secret, staleTs)).toBe(false);
  });

  it("rejects a future timestamp (> 5 min ahead)", () => {
    const futureTs = String(Math.floor(Date.now() / 1000) + 400);
    const sig = stoaSign(secret, body, futureTs);
    expect(verifyStoaSignature(body, sig, secret, futureTs)).toBe(false);
  });

  it("rejects when timestamp header is missing", () => {
    const ts = nowTs();
    const sig = stoaSign(secret, body, ts);
    expect(verifyStoaSignature(body, sig, secret, "")).toBe(false);
  });
});

describe("verifyGitHubSignature", () => {
  const secret = "gh-secret";
  const body = JSON.stringify({ action: "opened" });

  it("accepts sha256=<hex> format", () => {
    const sig = "sha256=" + hmacHex(secret, body);
    expect(verifyGitHubSignature(body, sig, secret)).toBe(true);
  });

  it("accepts bare hex (no prefix) for flexibility", () => {
    const sig = hmacHex(secret, body);
    expect(verifyGitHubSignature(body, sig, secret)).toBe(true);
  });

  it("rejects a wrong sha256= signature", () => {
    const bad = "sha256=" + hmacHex(secret, body).replace(/^./, "0");
    expect(verifyGitHubSignature(body, bad, secret)).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(verifyGitHubSignature(body, "", secret)).toBe(false);
  });

  it("rejects sha256= with no hex following", () => {
    expect(verifyGitHubSignature(body, "sha256=", secret)).toBe(false);
  });

  it("rejects non-hex garbage of length 64", () => {
    expect(verifyGitHubSignature(body, "g".repeat(64), secret)).toBe(false);
  });
});

describe("getWebhookSecret", () => {
  afterEach(() => {
    delete process.env.STOA_WEBHOOK_SECRET;
  });

  it("returns null when env var is absent", () => {
    delete process.env.STOA_WEBHOOK_SECRET;
    expect(getWebhookSecret()).toBeNull();
  });

  it("returns null when env var is empty string", () => {
    process.env.STOA_WEBHOOK_SECRET = "";
    expect(getWebhookSecret()).toBeNull();
  });

  it("returns the secret when set", () => {
    process.env.STOA_WEBHOOK_SECRET = "s3cret";
    expect(getWebhookSecret()).toBe("s3cret");
  });
});

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

describe("parseStoaWebhook", () => {
  it("parses a minimal valid payload", () => {
    const result = parseStoaWebhook({
      event: "task",
      repo: "r1",
      title: "Fix the bug",
    });
    expect(result).toEqual({ repo: "r1", title: "Fix the bug" });
  });

  it("parses payload with optional body and labels", () => {
    const result = parseStoaWebhook({
      event: "task",
      repo: "r1",
      title: "Fix",
      body: "some context",
      labels: ["bug", "p1"],
    });
    expect(result).toEqual({
      repo: "r1",
      title: "Fix",
      body: "some context",
      labels: ["bug", "p1"],
    });
  });

  it("returns null for wrong event type", () => {
    expect(parseStoaWebhook({ event: "ping", repo: "r1", title: "t" })).toBeNull();
  });

  it("returns null when repo is missing", () => {
    expect(parseStoaWebhook({ event: "task", title: "t" })).toBeNull();
  });

  it("returns null when title is missing", () => {
    expect(parseStoaWebhook({ event: "task", repo: "r1" })).toBeNull();
  });

  it("returns null when title exceeds 500 chars", () => {
    expect(
      parseStoaWebhook({ event: "task", repo: "r1", title: "x".repeat(501) })
    ).toBeNull();
  });

  it("returns null when body exceeds 10000 chars", () => {
    expect(
      parseStoaWebhook({
        event: "task",
        repo: "r1",
        title: "t",
        body: "x".repeat(10_001),
      })
    ).toBeNull();
  });

  it("filters non-string labels and caps at 20", () => {
    const labels = [
      ...Array(25).fill("tag"),
      42,
      null,
    ] as unknown[];
    const result = parseStoaWebhook({ event: "task", repo: "r1", title: "t", labels });
    expect(result?.labels?.length).toBe(20);
    expect(result?.labels?.every((l) => typeof l === "string")).toBe(true);
  });

  it("returns null for a non-object payload", () => {
    expect(parseStoaWebhook("string")).toBeNull();
    expect(parseStoaWebhook(null)).toBeNull();
    expect(parseStoaWebhook([])).toBeNull();
  });
});

describe("parseGitHubWebhook", () => {
  const opened = {
    action: "opened",
    issue: {
      number: 7,
      title: "Bug report",
      body: "Steps to reproduce",
      html_url: "https://github.com/o/r/issues/7",
      created_at: "2026-06-01T00:00:00Z",
    },
    repository: { full_name: "o/r" },
  };

  it("parses a valid issues.opened payload", () => {
    const result = parseGitHubWebhook(opened, "issues");
    expect(result).toEqual({
      repo: "o/r",
      title: "Bug report",
      body: "Steps to reproduce",
    });
  });

  it("truncates body at BODY_MAX (10000 chars)", () => {
    const big = {
      ...opened,
      issue: { ...opened.issue, body: "x".repeat(10_001) },
    };
    const result = parseGitHubWebhook(big, "issues");
    expect(result?.body?.length).toBe(10_000);
  });

  it("returns null for event type other than 'issues'", () => {
    expect(parseGitHubWebhook(opened, "push")).toBeNull();
    expect(parseGitHubWebhook(opened, "pull_request")).toBeNull();
    expect(parseGitHubWebhook(opened, "ping")).toBeNull();
  });

  it("returns null for action other than 'opened'", () => {
    expect(
      parseGitHubWebhook({ ...opened, action: "closed" }, "issues")
    ).toBeNull();
    expect(
      parseGitHubWebhook({ ...opened, action: "labeled" }, "issues")
    ).toBeNull();
  });

  it("returns null when title exceeds 500 chars", () => {
    const big = {
      ...opened,
      issue: { ...opened.issue, title: "x".repeat(501) },
    };
    expect(parseGitHubWebhook(big, "issues")).toBeNull();
  });

  it("returns null for non-object payload", () => {
    expect(parseGitHubWebhook(null, "issues")).toBeNull();
    expect(parseGitHubWebhook("bad", "issues")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// insertWebhookTask DB query
// ---------------------------------------------------------------------------

describe("insertWebhookTask query", () => {
  let db: InstanceType<typeof Database>;
  const repoId = randomUUID();

  beforeAll(() => {
    db = new Database(":memory:");
    createSchema(db);
    runMigrations(db);
    queries
      .createDispatchRepo(db)
      .run(
        repoId,
        "/tmp/repo",
        "o/r",
        "claude",
        5,
        5,
        null,
        "main",
        "auto",
        1,
        0,
        0,
        0,
        0,
        null,
        "uncategorized"
      );
  });

  it("inserts with source='webhook', issue_number=0, status='pending'", () => {
    const id = randomUUID();
    queries
      .insertWebhookTask(db)
      .run(id, repoId, "Fix the login bug", "some body", new Date().toISOString());
    const row = db
      .prepare("SELECT * FROM issue_dispatches WHERE id = ?")
      .get(id) as IssueDispatch;
    expect(row.source).toBe("webhook");
    expect(row.issue_number).toBe(0);
    expect(row.status).toBe("pending");
    expect(row.issue_title).toBe("Fix the login bug");
    expect(row.task_body).toBe("some body");
  });

  it("two webhook tasks with the same title coexist (no dedup collision)", () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    const now = new Date().toISOString();
    queries.insertWebhookTask(db).run(id1, repoId, "Same title", null, now);
    queries.insertWebhookTask(db).run(id2, repoId, "Same title", null, now);
    const rows = db
      .prepare(
        "SELECT * FROM issue_dispatches WHERE id IN (?, ?) ORDER BY rowid"
      )
      .all(id1, id2) as IssueDispatch[];
    expect(rows.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Route integration — mock getDb() to use an in-memory DB
// ---------------------------------------------------------------------------
//
// The mocks for @/lib/db and @/lib/api-security are declared at the TOP of
// this file (above) using vi.hoisted() + top-level vi.mock() because vitest
// hoists vi.mock calls regardless of nesting level.  Per-test state is mutated
// through the `shared` cell.

describe("POST /api/webhooks/intake — integration", () => {
  const secret = "integration-secret";
  const repoId = randomUUID();

  // Import the route once; it picks up the top-level mock for @/lib/db.
  let POST: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    // Build and seed the in-memory DB that shared.db will point to.
    const db = new Database(":memory:");
    createSchema(db);
    runMigrations(db);
    queries
      .createDispatchRepo(db)
      .run(
        repoId,
        "/tmp/repo",
        "o/r",
        "claude",
        5,
        5,
        null,
        "main",
        "auto",
        1,
        0,
        0,
        0,
        0,
        null,
        "uncategorized"
      );
    shared.db = db;

    // Import the route AFTER the mock is in place (top-level vi.mock guarantees
    // this, but we still import lazily to be explicit).
    const mod = await import("@/app/api/webhooks/intake/route");
    POST = mod.POST as unknown as (req: Request) => Promise<Response>;
  });

  beforeEach(() => {
    (shared.db as InstanceType<typeof Database>).exec(
      "DELETE FROM issue_dispatches"
    );
    process.env.STOA_WEBHOOK_SECRET = secret;
    shared.rateLimitAllowed = true;
    shared.rateLimitRetryAfter = undefined;
  });

  afterEach(() => {
    delete process.env.STOA_WEBHOOK_SECRET;
  });

  // --- secret not configured ---
  it("returns 503 when STOA_WEBHOOK_SECRET is not set", async () => {
    delete process.env.STOA_WEBHOOK_SECRET;
    const body = JSON.stringify({ event: "task", repo: repoId, title: "t" });
    const req = makeRequest({ body });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toMatch(/secret not configured/i);
  });

  // --- invalid signature ---
  it("returns 401 for a wrong native signature", async () => {
    const body = JSON.stringify({ event: "task", repo: repoId, title: "t" });
    const ts = nowTs();
    const req = makeRequest({
      body,
      headers: {
        "x-stoa-signature": "deadbeef".repeat(8),
        "x-stoa-timestamp": ts,
      },
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(401);
  });

  it("returns 401 when native signature header is missing", async () => {
    const body = JSON.stringify({ event: "task", repo: repoId, title: "t" });
    const req = makeRequest({ body }); // no signature header
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(401);
  });

  // --- malformed JSON ---
  it("returns 400 for malformed JSON body (native event)", async () => {
    const body = "not-json";
    const ts = nowTs();
    const sig = stoaSign(secret, body, ts);
    const req = makeRequest({
      body,
      headers: { "x-stoa-signature": sig, "x-stoa-timestamp": ts },
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
  });

  // --- unknown repo ---
  it("returns 404 when repo is not in the DB", async () => {
    const body = JSON.stringify({
      event: "task",
      repo: "nonexistent-slug",
      title: "Fix",
    });
    const ts = nowTs();
    const sig = stoaSign(secret, body, ts);
    const req = makeRequest({
      body,
      headers: { "x-stoa-signature": sig, "x-stoa-timestamp": ts },
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(404);
    // Repo name must not be echoed back in the error message.
    const json = await res.json();
    expect(json.error).not.toContain("nonexistent-slug");
  });

  // --- native Stoa task event ---
  it("inserts source='webhook' row for a valid native task event (lookup by id)", async () => {
    const body = JSON.stringify({
      event: "task",
      repo: repoId, // UUID lookup
      title: "Fix the login bug",
      body: "reproducible every time",
    });
    const ts = nowTs();
    const sig = stoaSign(secret, body, ts);
    const req = makeRequest({
      body,
      headers: { "x-stoa-signature": sig, "x-stoa-timestamp": ts },
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(typeof json.issueId).toBe("string");

    const row = (shared.db as InstanceType<typeof Database>)
      .prepare("SELECT * FROM issue_dispatches WHERE id = ?")
      .get(json.issueId) as IssueDispatch;
    expect(row.source).toBe("webhook");
    expect(row.status).toBe("pending");
    expect(row.issue_title).toBe("Fix the login bug");
    expect(row.task_body).toBe("reproducible every time");
    expect(row.issue_number).toBe(0);
  });

  it("inserts source='webhook' row when repo is identified by slug", async () => {
    const body = JSON.stringify({
      event: "task",
      repo: "o/r", // slug lookup
      title: "Slug lookup task",
    });
    const ts = nowTs();
    const sig = stoaSign(secret, body, ts);
    const req = makeRequest({
      body,
      headers: { "x-stoa-signature": sig, "x-stoa-timestamp": ts },
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(200);
    const row = (shared.db as InstanceType<typeof Database>)
      .prepare(
        "SELECT * FROM issue_dispatches WHERE source = 'webhook' ORDER BY rowid DESC LIMIT 1"
      )
      .get() as IssueDispatch;
    expect(row.issue_title).toBe("Slug lookup task");
  });

  // --- GitHub issues.opened ---
  it("inserts source='github' row for GitHub issues.opened event", async () => {
    const payload = {
      action: "opened",
      issue: {
        number: 42,
        title: "GitHub bug report",
        body: "Reproducible",
        html_url: "https://github.com/o/r/issues/42",
        created_at: "2026-06-01T00:00:00Z",
      },
      repository: { full_name: "o/r" },
    };
    const body = JSON.stringify(payload);
    const sig = "sha256=" + hmacHex(secret, body);
    const req = makeRequest({
      body,
      headers: {
        "x-hub-signature-256": sig,
        "x-github-event": "issues",
      },
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    const row = (shared.db as InstanceType<typeof Database>)
      .prepare("SELECT * FROM issue_dispatches WHERE issue_number = 42")
      .get() as IssueDispatch;
    expect(row).toBeDefined();
    expect(row.source).toBe("github");
    expect(row.issue_title).toBe("GitHub bug report");
    expect(row.issue_url).toBe("https://github.com/o/r/issues/42");
  });

  // --- GitHub unknown/ignored event ---
  it("returns 200 with ignored=true for a GitHub 'ping' event (not 'issues')", async () => {
    const body = JSON.stringify({ zen: "Practicality beats purity." });
    const sig = "sha256=" + hmacHex(secret, body);
    const req = makeRequest({
      body,
      headers: {
        "x-hub-signature-256": sig,
        "x-github-event": "ping",
      },
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ignored).toBe(true);
    const count = (
      (shared.db as InstanceType<typeof Database>)
        .prepare("SELECT COUNT(*) n FROM issue_dispatches")
        .get() as { n: number }
    ).n;
    expect(count).toBe(0); // nothing inserted
  });

  it("returns 200 with ignored=true for issues.closed (not 'opened')", async () => {
    const payload = {
      action: "closed",
      issue: {
        number: 1,
        title: "Done",
        body: null,
        html_url: "https://github.com/o/r/issues/1",
        created_at: "2026-06-01T00:00:00Z",
      },
      repository: { full_name: "o/r" },
    };
    const body = JSON.stringify(payload);
    const sig = "sha256=" + hmacHex(secret, body);
    const req = makeRequest({
      body,
      headers: {
        "x-hub-signature-256": sig,
        "x-github-event": "issues",
      },
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(200);
    expect((await res.json()).ignored).toBe(true);
  });

  // --- rate limiting ---
  it("returns 429 when rate limit is exceeded", async () => {
    shared.rateLimitAllowed = false;
    shared.rateLimitRetryAfter = 42;
    const body = JSON.stringify({ event: "task", repo: repoId, title: "t" });
    const req = makeRequest({ body });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(429);
  });
});
