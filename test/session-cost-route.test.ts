import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "../lib/db/schema";
import { runMigrations } from "../lib/db/migrations";

// GET /api/sessions/cost feeds the cost UI AND is the same computation the
// budget-kill / budget-park loops run — #22 locks its contract: per-session
// failures (missing/garbled transcripts, unpriced models, readerless agents)
// degrade to zeros/nulls with a 200; only a catastrophic DB failure may 500,
// and even that is a clean JSON error, never an unhandled crash.

const holder = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => holder.db };
});

// Mock the transcript fs boundary (same seam as session-cost.test.ts) so the
// route runs its REAL pipeline — queries → computeSessionCosts → pricing →
// budget levels — against controlled transcript bytes, no real files.
vi.mock("@/lib/claude-transcript", () => ({
  readClaudeTranscriptRaw: vi.fn(),
  resolveClaudeTranscriptPath: vi.fn(
    (_cwd: string, id: string) => `/fake/${id}.jsonl`
  ),
}));

import { GET } from "@/app/api/sessions/cost/route";
import { readClaudeTranscriptRaw } from "@/lib/claude-transcript";
import { queries } from "@/lib/db";

const db = () => holder.db;

function insertSession(opts: {
  id: string;
  agent?: string;
  model?: string | null;
  claudeSessionId?: string | null;
}) {
  queries.createSession(db()).run(
    opts.id,
    `sess-${opts.id}`,
    opts.id, // tmux_name
    "/repo", // working_directory (NOT NULL; never touched — reader is mocked)
    null, // parent_session_id
    opts.model === undefined ? "claude-sonnet-4-6" : opts.model,
    null, // system_prompt
    "sessions", // group_path
    opts.agent ?? "claude",
    0, // auto_approve
    null // project_id
  );
  if (opts.claudeSessionId !== null) {
    db()
      .prepare(`UPDATE sessions SET claude_session_id = ? WHERE id = ?`)
      .run(opts.claudeSessionId ?? `cid-${opts.id}`, opts.id);
  }
}

const usageLine = (input: number, output: number) =>
  JSON.stringify({
    type: "assistant",
    message: {
      id: "m1",
      usage: { input_tokens: input, output_tokens: output },
    },
  });

const prevCacheEnv = process.env.STOA_TRANSCRIPT_CACHE;

beforeAll(() => {
  // Cache off so every GET re-reads the mocked transcript (the #18 cache has
  // its own tests) — the kill switch is read live per call, and scoping it to
  // this suite keeps it from leaking to other files in the same worker.
  process.env.STOA_TRANSCRIPT_CACHE = "0";
  const mem = new Database(":memory:");
  createSchema(mem);
  runMigrations(mem);
  holder.db = mem;
});

afterAll(() => {
  if (prevCacheEnv === undefined) delete process.env.STOA_TRANSCRIPT_CACHE;
  else process.env.STOA_TRANSCRIPT_CACHE = prevCacheEnv;
});

beforeEach(() => {
  db().exec("DELETE FROM session_costs");
  db().exec("DELETE FROM sessions");
  vi.mocked(readClaudeTranscriptRaw).mockReset();
  delete process.env.STOA_BUDGET_SOFT_USD;
  delete process.env.STOA_BUDGET_HARD_USD;
});

afterEach(() => {
  delete process.env.STOA_BUDGET_SOFT_USD;
  delete process.env.STOA_BUDGET_HARD_USD;
});

describe("GET /api/sessions/cost (#22 — never 500s on per-session failures)", () => {
  it("200 with an empty fleet", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions).toEqual({});
    expect(body.totalUsd).toBe(0);
    expect(body.levels).toEqual({});
    expect(body.budget).toEqual({ softUsd: null, hardUsd: null });
  });

  it("200 for a mixed fleet: priced claude + readerless codex + missing transcript", async () => {
    insertSession({ id: "good" });
    insertSession({ id: "codex", agent: "codex" });
    insertSession({ id: "gone" });
    // "good" gets a real transcript; "gone"'s is unreadable (reader → null,
    // exactly what the real fs boundary returns for a deleted/foreign file).
    vi.mocked(readClaudeTranscriptRaw).mockImplementation(
      async (_cwd: string, sessionId: string) =>
        sessionId === "cid-good" ? usageLine(1_000_000, 0) : null
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.sessions).sort()).toEqual([
      "codex",
      "gone",
      "good",
    ]);
    expect(body.sessions["good"].costUsd).toBeCloseTo(3); // 1M input × $3/Mtok
    expect(body.sessions["good"].supported).toBe(true);
    expect(body.sessions["codex"].supported).toBe(false);
    expect(body.sessions["codex"].costUsd).toBeNull();
    expect(body.sessions["gone"].supported).toBe(true);
    expect(body.sessions["gone"].costUsd).toBe(0); // best-effort zero
    expect(body.totalUsd).toBeCloseTo(3);
  });

  it("200 when a transcript is pure garbage (parsers skip malformed lines)", async () => {
    insertSession({ id: "garble" });
    vi.mocked(readClaudeTranscriptRaw).mockResolvedValue(
      "{ not json\n\x00\x01binary-ish\nplain text"
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions["garble"].tokens).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("maps budget levels from the fleet's costs (soft breach)", async () => {
    process.env.STOA_BUDGET_SOFT_USD = "1";
    insertSession({ id: "pricey" });
    vi.mocked(readClaudeTranscriptRaw).mockResolvedValue(
      usageLine(1_000_000, 0) // $3 on sonnet > $1 soft cap
    );
    const res = await GET();
    const body = await res.json();
    expect(body.budget).toEqual({ softUsd: 1, hardUsd: null });
    expect(body.levels["pricey"]).toBe("soft");
  });

  it("a catastrophic DB failure is a CLEAN 500 JSON error, not a crash", async () => {
    const real = holder.db;
    try {
      holder.db = new Database(":memory:"); // no schema → getAllSessions throws
      const res = await GET();
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Failed to compute cost");
    } finally {
      holder.db.close();
      holder.db = real;
    }
  });
});
