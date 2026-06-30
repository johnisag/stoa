/**
 * Audit / event ledger: schema + queries round-trip, and the RecordingBackend
 * decorator's recording behavior — that it records the right event types and
 * payloads, swallows DB failures without breaking the wrapped op, and is a pure
 * passthrough when the ledger is disabled. Uses a real in-memory SQLite (real
 * schema + migrations + queries) with getDb() mocked to point at it.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

// Mutable holder so the db mock returns the in-memory db created in beforeAll.
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => state.db };
});

import { queries } from "@/lib/db";
import type { SessionEvent } from "@/lib/db/types";
import {
  recordEvent,
  RecordingBackend,
  withAudit,
  auditEnabled,
} from "@/lib/audit/ledger";
import type {
  SessionBackend,
  CreateOptions,
} from "@/lib/session-backend/types";

function db() {
  return state.db as InstanceType<typeof Database>;
}

function events(key: string): SessionEvent[] {
  return queries.getSessionEvents(db()).all(key) as SessionEvent[];
}

/** A minimal fake backend that records call order; every method resolves. */
function fakeBackend(): SessionBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async create(o: CreateOptions) {
      calls.push(`create:${o.name}`);
    },
    async kill(n: string) {
      calls.push(`kill:${n}`);
    },
    async rename(o: string, n: string) {
      calls.push(`rename:${o}->${n}`);
    },
    async exists() {
      return true;
    },
    async list() {
      return [];
    },
    async listWithActivity() {
      return [];
    },
    async getPanePath() {
      return null;
    },
    async getEnv() {
      return null;
    },
    async getPid() {
      return null;
    },
    async capture() {
      return "";
    },
    async sendEnter(n: string) {
      calls.push(`enter:${n}`);
    },
    async sendEscape(n: string) {
      calls.push(`escape:${n}`);
    },
    async sendKeysLiteral(n: string, t: string) {
      calls.push(`literal:${n}:${t}`);
    },
    async sendKeysInterpreted(n: string, t: string) {
      calls.push(`interp:${n}:${t}`);
    },
    async pasteText(n: string, t: string) {
      calls.push(`paste:${n}:${t}`);
    },
  };
}

beforeAll(() => {
  const d = new Database(":memory:");
  createSchema(d);
  runMigrations(d);
  state.db = d;
});

beforeEach(() => {
  db().exec("DELETE FROM session_events;");
  delete process.env.STOA_AUDIT;
  delete process.env.STOA_AUDIT_INPUT_TEXT;
});

describe("ledger schema + queries", () => {
  it("appends and reads back events in insertion order", () => {
    recordEvent("k1", "session_create", { cwd: "/tmp" });
    recordEvent("k1", "input_enter");
    recordEvent("k2", "session_kill");

    const k1 = events("k1");
    expect(k1.map((e) => e.event_type)).toEqual([
      "session_create",
      "input_enter",
    ]);
    expect(JSON.parse(k1[0].payload!)).toEqual({ cwd: "/tmp" });
    expect(k1[1].payload).toBeNull();
    expect(typeof k1[0].created_at).toBe("number");

    expect(events("k2").map((e) => e.event_type)).toEqual(["session_kill"]);
    expect(
      (queries.countSessionEvents(db()).get("k1") as { n: number }).n
    ).toBe(2);
  });

  it("filters by type", () => {
    recordEvent("k", "input_text", { length: 3 });
    recordEvent("k", "input_enter");
    recordEvent("k", "input_text", { length: 5 });
    const texts = queries
      .getSessionEventsByType(db())
      .all("k", "input_text") as SessionEvent[];
    expect(texts).toHaveLength(2);
    expect(texts.map((e) => JSON.parse(e.payload!).length)).toEqual([3, 5]);
  });

  it("recordEvent swallows a DB failure instead of throwing", () => {
    const spy = vi
      .spyOn(queries, "appendSessionEvent")
      .mockImplementation(() => {
        throw new Error("db boom");
      });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => recordEvent("k", "session_kill")).not.toThrow();
      expect(errSpy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe("RecordingBackend decorator", () => {
  it("records lifecycle events and delegates to the inner backend", async () => {
    const inner = fakeBackend();
    const rec = new RecordingBackend(inner);

    await rec.create({
      name: "claude-1",
      cwd: "/work",
      command: "claude --foo",
      binary: "claude",
      args: ["--foo", "--bar"],
    });
    await rec.kill("claude-1");

    expect(inner.calls).toEqual(["create:claude-1", "kill:claude-1"]);
    const evs = events("claude-1");
    expect(evs.map((e) => e.event_type)).toEqual([
      "session_create",
      "session_kill",
    ]);
    const created = JSON.parse(evs[0].payload!);
    expect(created.cwd).toBe("/work");
    expect(created.binary).toBe("claude");
    expect(created.argCount).toBe(2);
    // command is recorded whenever it is present (regardless of binary path),
    // so the audit trail captures the exact shell command used.
    expect(created.command).toBe("claude --foo");
  });

  it("records the shell command verbatim when no binary is given (tmux/fallback path)", async () => {
    const rec = new RecordingBackend(fakeBackend());
    await rec.create({
      name: "shell-1",
      cwd: "/work",
      command: "echo hi && ls",
    });
    const created = JSON.parse(events("shell-1")[0].payload!);
    expect(created.command).toBe("echo hi && ls");
    expect(created.binary).toBeUndefined();
    expect(created.argCount).toBe(0);
  });

  it("keys a rename under the new name and preserves the old in the payload", async () => {
    const rec = new RecordingBackend(fakeBackend());
    await rec.rename("old-k", "new-k");
    expect(events("old-k")).toHaveLength(0);
    const evs = events("new-k");
    expect(evs).toHaveLength(1);
    expect(evs[0].event_type).toBe("session_rename");
    expect(JSON.parse(evs[0].payload!)).toEqual({ from: "old-k" });
  });

  it("records input metadata (length only) by default — not the verbatim text", async () => {
    const rec = new RecordingBackend(fakeBackend());
    await rec.sendKeysLiteral("k", "secret-token");
    await rec.pasteText("k", "multi\nline", { enter: true });
    await rec.sendKeysInterpreted("k", "hello", { enter: false });
    await rec.sendKeysInterpreted("k", "go", { enter: true });
    await rec.sendEnter("k");
    await rec.sendEscape("k");

    const evs = events("k");
    expect(evs.map((e) => e.event_type)).toEqual([
      "input_text",
      "input_paste",
      "input_text",
      "input_text",
      "input_enter",
      "input_escape",
    ]);
    const literal = JSON.parse(evs[0].payload!);
    expect(literal.length).toBe("secret-token".length);
    expect(literal.text).toBeUndefined(); // secret NOT stored verbatim by default
    const paste = JSON.parse(evs[1].payload!);
    expect(paste.length).toBe("multi\nline".length);
    expect(paste.enter).toBe(true);
    // The interpreted `enter` flag is recorded faithfully (false AND true).
    expect(JSON.parse(evs[2].payload!).enter).toBe(false);
    expect(JSON.parse(evs[3].payload!).enter).toBe(true);
  });

  it("stores verbatim text only when STOA_AUDIT_INPUT_TEXT is opted in", async () => {
    process.env.STOA_AUDIT_INPUT_TEXT = "1";
    const rec = new RecordingBackend(fakeBackend());
    await rec.sendKeysLiteral("k", "visible");
    expect(JSON.parse(events("k")[0].payload!).text).toBe("visible");
  });

  it("truncates verbatim text past the cap and flags it (no row-bloat from a big paste)", async () => {
    process.env.STOA_AUDIT_INPUT_TEXT = "1";
    const rec = new RecordingBackend(fakeBackend());
    const big = "x".repeat(64 * 1024 + 100);
    await rec.pasteText("k", big);
    const payload = JSON.parse(events("k")[0].payload!);
    expect(payload.length).toBe(big.length); // true length retained
    expect(payload.text.length).toBe(64 * 1024); // stored text capped
    expect(payload.truncated).toBe(true);
  });

  it("records create AFTER the spawn succeeds — nothing logged when it throws", async () => {
    const inner = fakeBackend();
    inner.create = async () => {
      throw new Error("spawn failed");
    };
    const rec = new RecordingBackend(inner);
    await expect(
      rec.create({ name: "k", cwd: "/x", command: "boom" })
    ).rejects.toThrow("spawn failed");
    // No event — the ledger reflects what actually ran.
    expect(events("k")).toHaveLength(0);
  });

  it("records kill BEFORE delegating — the event lands even if the kill throws", async () => {
    const inner = fakeBackend();
    inner.kill = async () => {
      throw new Error("kill failed");
    };
    const rec = new RecordingBackend(inner);
    await expect(rec.kill("k")).rejects.toThrow("kill failed");
    // The kill intent is still recorded (it raced no teardown of the ledger).
    expect(events("k").map((e) => e.event_type)).toEqual(["session_kill"]);
  });

  it("read-only operations are not recorded AND delegate their return values", async () => {
    const rec = new RecordingBackend(fakeBackend());
    expect(await rec.exists("k")).toBe(true);
    expect(await rec.list()).toEqual([]);
    expect(await rec.listWithActivity()).toEqual([]);
    expect(await rec.capture("k")).toBe("");
    expect(await rec.getPanePath("k")).toBeNull();
    expect(await rec.getEnv("k", "X")).toBeNull();
    expect(events("k")).toHaveLength(0);
  });

  it("still completes the wrapped op when recording fails", async () => {
    const inner = fakeBackend();
    const rec = new RecordingBackend(inner);
    const spy = vi
      .spyOn(queries, "appendSessionEvent")
      .mockImplementation(() => {
        throw new Error("db boom");
      });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(rec.kill("k")).resolves.toBeUndefined();
      expect(inner.calls).toEqual(["kill:k"]); // the kill still happened
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe("withAudit flag", () => {
  it("wraps when enabled (default) and records", async () => {
    const inner = fakeBackend();
    const wrapped = withAudit(inner);
    expect(wrapped).toBeInstanceOf(RecordingBackend);
    expect(auditEnabled()).toBe(true);
    await wrapped.kill("k");
    expect(events("k")).toHaveLength(1);
  });

  it("is a pure passthrough when disabled", async () => {
    process.env.STOA_AUDIT = "0";
    const inner = fakeBackend();
    const wrapped = withAudit(inner);
    expect(wrapped).toBe(inner); // same object — no decorator
    expect(auditEnabled()).toBe(false);
    await wrapped.kill("k");
    expect(events("k")).toHaveLength(0); // nothing recorded
  });
});
