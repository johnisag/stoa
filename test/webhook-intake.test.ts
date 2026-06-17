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
// Helpers
// ---------------------------------------------------------------------------

function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
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

  it("accepts a correct HMAC-SHA256 hex signature", () => {
    const sig = hmacHex(secret, body);
    expect(verifyStoaSignature(body, sig, secret)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const bad = hmacHex(secret, body).replace(/^./, "0");
    expect(verifyStoaSignature(body, bad, secret)).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(verifyStoaSignature(body, "", secret)).toBe(false);
  });

  it("rejects when body has been tampered", () => {
    const sig = hmacHex(secret, body);
    expect(verifyStoaSignature(body + " ", sig, secret)).toBe(false);
  });

  it("rejects a signature of the wrong length (length mismatch guard)", () => {
    // shorter hex — must not throw (timingSafeEqual requires equal lengths)
    expect(verifyStoaSignature(body, "abc123", secret)).toBe(false);
  });
});

describe("verifyGitHubSignature", () => {
  const secret = "gh-secret";
  const body = JSON.stringify({ action: "opened" });

  it("accepts sha256=<hex> format", () => {
    const sig = "sha256=" + hmacHex(secret, body);
    expect(verifyGitHubSignature(body, sig, secret)).toBe(true);
  });

  it("rejects bare hex without sha256= prefix", () => {
    const sig = hmacHex(secret, body);
    expect(verifyGitHubSignature(body, sig, secret)).toBe(false);
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
    expect(
      parseStoaWebhook({ event: "ping", repo: "r1", title: "t" })
    ).toBeNull();
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
    const labels = [...Array(25).fill("tag"), 42, null] as unknown[];
    const result = parseStoaWebhook({
      event: "task",
      repo: "r1",
      title: "t",
      labels,
    });
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

  it("parses a valid issues.opened payload including GitHub metadata", () => {
    const result = parseGitHubWebhook(opened, "issues");
    expect(result).toEqual({
      repo: "o/r",
      title: "Bug report",
      body: "Steps to reproduce",
      issueNumber: 7,
      issueUrl: "https://github.com/o/r/issues/7",
      issueCreatedAt: "2026-06-01T00:00:00Z",
    });
  });

  it("returns null when issue.number is missing or non-positive", () => {
    const noNumber = {
      ...opened,
      issue: { ...opened.issue, number: undefined },
    };
    expect(parseGitHubWebhook(noNumber, "issues")).toBeNull();
    const zeroNumber = { ...opened, issue: { ...opened.issue, number: 0 } };
    expect(parseGitHubWebhook(zeroNumber, "issues")).toBeNull();
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
        "test-repo-path",
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
      .run(
        id,
        repoId,
        "Fix the login bug",
        "some body",
        new Date().toISOString()
      );
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
// vi.mock() factories are hoisted to module scope by vitest's transformer, so
// they cannot close over describe-local variables. We use module-level mutable
// state instead; each factory reads the current value at call time.
let _intDb: InstanceType<typeof Database> | undefined;
let _rlAllowed = true;
let _rlRetryAfter: number | undefined;

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return { ...actual, getDb: () => _intDb! };
});
vi.mock("@/lib/api-security", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-security")>(
      "@/lib/api-security"
    );
  return {
    ...actual,
    checkRateLimit: () => ({ allowed: _rlAllowed, retryAfter: _rlRetryAfter }),
  };
});

describe("POST /api/webhooks/intake — integration", () => {
  const secret = "integration-secret";
  const repoId = randomUUID();

  beforeAll(() => {
    _intDb = new Database(":memory:");
    createSchema(_intDb);
    runMigrations(_intDb);
    queries
      .createDispatchRepo(_intDb)
      .run(
        repoId,
        "test-repo-path",
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

  beforeEach(() => {
    _intDb!.exec("DELETE FROM issue_dispatches");
    _rlAllowed = true;
    _rlRetryAfter = undefined;
    process.env.STOA_WEBHOOK_SECRET = secret;
    // Reset module cache so each test imports a fresh route that picks up the
    // current mock factories.
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.STOA_WEBHOOK_SECRET;
  });

  async function getRoute() {
    const mod = await import("@/app/api/webhooks/intake/route");
    return mod.POST;
  }

  // --- secret not configured ---
  it("returns 503 when STOA_WEBHOOK_SECRET is not set", async () => {
    delete process.env.STOA_WEBHOOK_SECRET;
    const POST = await getRoute();
    const body = JSON.stringify({ event: "task", repo: repoId, title: "t" });
    const req = makeRequest({ body });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toMatch(/secret not configured/i);
  });

  // --- invalid signature ---
  it("returns 401 for a wrong native signature", async () => {
    const POST = await getRoute();
    const body = JSON.stringify({ event: "task", repo: repoId, title: "t" });
    const req = makeRequest({
      body,
      headers: { "x-stoa-signature": "deadbeef".repeat(8) },
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(401);
  });

  it("returns 401 when native signature header is missing", async () => {
    const POST = await getRoute();
    const body = JSON.stringify({ event: "task", repo: repoId, title: "t" });
    const req = makeRequest({ body }); // no signature header
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(401);
  });

  // --- malformed JSON ---
  it("returns 400 for malformed JSON body (native event)", async () => {
    const POST = await getRoute();
    const body = "not-json";
    const sig = hmacHex(secret, body);
    const req = makeRequest({ body, headers: { "x-stoa-signature": sig } });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
  });

  // --- unknown repo ---
  it("returns 404 when repo is not in the DB", async () => {
    const POST = await getRoute();
    const body = JSON.stringify({
      event: "task",
      repo: "nonexistent-slug",
      title: "Fix",
    });
    const sig = hmacHex(secret, body);
    const req = makeRequest({ body, headers: { "x-stoa-signature": sig } });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(404);
  });

  // --- native Stoa task event ---
  it("inserts source='webhook' row for a valid native task event (lookup by id)", async () => {
    const POST = await getRoute();
    const body = JSON.stringify({
      event: "task",
      repo: repoId, // UUID lookup
      title: "Fix the login bug",
      body: "reproducible every time",
    });
    const sig = hmacHex(secret, body);
    const req = makeRequest({ body, headers: { "x-stoa-signature": sig } });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(typeof json.issueId).toBe("string");

    const row = _intDb!
      .prepare("SELECT * FROM issue_dispatches WHERE id = ?")
      .get(json.issueId) as IssueDispatch;
    expect(row.source).toBe("webhook");
    expect(row.status).toBe("pending");
    expect(row.issue_title).toBe("Fix the login bug");
    expect(row.task_body).toBe("reproducible every time");
    expect(row.issue_number).toBe(0);
  });

  it("inserts source='webhook' row when repo is identified by slug", async () => {
    const POST = await getRoute();
    const body = JSON.stringify({
      event: "task",
      repo: "o/r", // slug lookup
      title: "Slug lookup task",
    });
    const sig = hmacHex(secret, body);
    const req = makeRequest({ body, headers: { "x-stoa-signature": sig } });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(200);
    const row = _intDb!
      .prepare(
        "SELECT * FROM issue_dispatches WHERE source = 'webhook' ORDER BY rowid DESC LIMIT 1"
      )
      .get() as IssueDispatch;
    expect(row.issue_title).toBe("Slug lookup task");
  });

  // --- GitHub issues.opened ---
  it("inserts source='github' row for GitHub issues.opened event", async () => {
    const POST = await getRoute();
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

    const row = _intDb!
      .prepare("SELECT * FROM issue_dispatches WHERE issue_number = 42")
      .get() as IssueDispatch;
    expect(row).toBeDefined();
    expect(row.source).toBe("github");
    expect(row.issue_title).toBe("GitHub bug report");
    expect(row.issue_url).toBe("https://github.com/o/r/issues/42");
  });

  // --- GitHub unknown/ignored event ---
  it("returns 200 with ignored=true for a GitHub 'ping' event (not 'issues')", async () => {
    const POST = await getRoute();
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
      _intDb!.prepare("SELECT COUNT(*) n FROM issue_dispatches").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(0); // nothing inserted
  });

  it("returns 200 with ignored=true for issues.closed (not 'opened')", async () => {
    const POST = await getRoute();
    const payload = {
      action: "closed",
      issue: {
        number: 1,
        title: "Done",
        body: null,
        html_url: "u",
        created_at: "t",
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
    // The module-level _rlAllowed flag controls what checkRateLimit() returns.
    // beforeEach already called vi.resetModules(), so the fresh route import
    // below picks up the current flag value.
    _rlAllowed = false;
    _rlRetryAfter = 42;
    const POST = await getRoute();
    const body = JSON.stringify({ event: "task", repo: repoId, title: "t" });
    const req = makeRequest({ body });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(429);
  });
});
