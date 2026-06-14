/**
 * Regression test for B008 — lib/claude/process-manager.ts
 *
 * registerClient wires BOTH the parser's "event" and "parse_error" handlers.
 * sendPrompt resets session.parser for each new conversation turn, but the
 * pre-fix code only re-attached "event" — so parse errors stopped being
 * broadcast to clients on the 2nd and later turns.
 *
 * Drives the real ClaudeProcessManager with child_process.spawn fully replaced
 * (the tmux-backend.test.ts pattern — full mock, no importOriginal) and the db
 * layer pointed at a real in-memory SQLite (command-execute.test.ts pattern).
 * sendPrompt resets the parser; we then feed a malformed NDJSON line through the
 * spawned process's stdout. The post-reset parser must still emit a "parse_error"
 * that the manager broadcasts to the registered client as an "error" event
 * prefixed "Parse error:".
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Minimal hand-rolled event emitter (no imports — the hoisted mock factory runs
// before module imports, and a require() inside it breaks vitest's runner).
type Emitter = {
  on: (ev: string, fn: (...a: unknown[]) => void) => Emitter;
  emit: (ev: string, ...a: unknown[]) => void;
};

// Holder for the most-recently-spawned fake process.
const { spawnState } = vi.hoisted(() => {
  const makeEmitter = (): Emitter => {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const e: Emitter = {
      on(ev, fn) {
        (handlers[ev] ||= []).push(fn);
        return e;
      },
      emit(ev, ...a) {
        for (const fn of handlers[ev] || []) fn(...a);
      },
    };
    return e;
  };
  return {
    spawnState: {
      makeEmitter,
      last: null as null | { stdout: Emitter },
    },
  };
});

// Full replacement of child_process (no importOriginal / no spread — that form
// corrupts vitest's own runtime, which uses child_process internally).
vi.mock("child_process", () => ({
  spawn: () => {
    const proc = spawnState.makeEmitter() as Emitter & {
      stdout: Emitter;
      stderr: Emitter;
      kill: (sig?: string) => void;
    };
    proc.stdout = spawnState.makeEmitter();
    proc.stderr = spawnState.makeEmitter();
    proc.kill = () => {};
    spawnState.last = proc;
    return proc;
  },
}));

const dbState = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => dbState.db };
});

import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db";
import { tmpDir } from "@/lib/platform";
import { ClaudeProcessManager } from "@/lib/claude/process-manager";

function db() {
  return dbState.db as InstanceType<typeof Database>;
}

// Minimal fake WebSocket capturing what the manager sends it. readyState=1
// matches WebSocket.OPEN, which broadcastToSession checks before sending.
class FakeWs {
  static OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];
  send(msg: string) {
    this.sent.push(JSON.parse(msg));
  }
}

beforeAll(() => {
  const memory = new Database(":memory:");
  createSchema(memory);
  runMigrations(memory);
  dbState.db = memory;
});

beforeEach(() => {
  db().exec("DELETE FROM messages; DELETE FROM sessions;");
  // Seed a bare session (project_id is nullable) so sendPrompt's DB reads/writes
  // succeed without a project FK.
  queries.createSession(db()).run(
    "s1", // id
    "Test", // name
    "s1", // tmux_name
    tmpDir(), // working_directory (NOT NULL) — platform temp dir
    null, // parent_session_id
    "sonnet", // model
    null, // system_prompt
    "sessions", // group_path (NOT NULL)
    "claude", // agent_type
    0, // auto_approve
    null // project_id
  );
});

describe("B008: parser parse_error handler survives a sendPrompt parser reset", () => {
  it("broadcasts parse errors on a post-reset parser turn", async () => {
    const mgr = new ClaudeProcessManager();
    const ws = new FakeWs();
    mgr.registerClient("s1", ws as unknown as import("ws").WebSocket);

    // sendPrompt resets session.parser and (post-fix) re-wires the
    // "parse_error" handler. The spawn is mocked, so no real process runs.
    await mgr.sendPrompt("s1", "hello");

    // Feed a malformed NDJSON line through the (reset) parser via stdout.
    spawnState.last!.stdout.emit("data", Buffer.from("{not valid json}\n"));

    const errorEvents = ws.sent.filter(
      (e): e is { type: string; data: { error: string } } =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "error"
    );

    expect(errorEvents.length).toBeGreaterThan(0);
    expect(
      errorEvents.some((e) => e.data.error.startsWith("Parse error:"))
    ).toBe(true);
  });
});
