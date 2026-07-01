import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

// Drive the REAL tick against an in-memory DB; the build itself is mocked (no
// real spawns) and runInBackground runs the task immediately so results are
// assertable synchronously after awaiting the captured promises.
const holder = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  verifyResult: { status: "pass", output: "" } as {
    status: string;
    output: string;
  },
  verifyCalls: [] as Array<{ cwd: string; command: string }>,
  tasks: [] as Promise<void>[],
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => holder.db };
});

vi.mock("@/lib/dispatch/verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dispatch/verify")>();
  return {
    ...actual,
    runVerify: vi.fn(async (cwd: string, command: string) => {
      holder.verifyCalls.push({ cwd, command });
      return holder.verifyResult;
    }),
  };
});

vi.mock("@/lib/async-operations", () => ({
  runInBackground: (task: () => Promise<void>) => {
    holder.tasks.push(task());
  },
}));

import { queries } from "@/lib/db";
import {
  decideSessionVerify,
  sessionVerifyTick,
  _resetSessionVerifyState,
} from "@/lib/session-verify";

const db = () => holder.db;
const drain = async () => {
  await Promise.all(holder.tasks);
  holder.tasks = [];
};

beforeAll(() => {
  const mem = new Database(":memory:");
  createSchema(mem);
  runMigrations(mem);
  holder.db = mem;
});

beforeEach(() => {
  db().exec("DELETE FROM sessions; DELETE FROM projects;");
  holder.verifyCalls = [];
  holder.tasks = [];
  holder.verifyResult = { status: "pass", output: "" };
  _resetSessionVerifyState();
  queries
    .createProject(db())
    .run("proj1", "P1", "~/p1", "claude", "sonnet", null, 1);
  db().exec(
    `UPDATE projects SET verify_command = 'npm test' WHERE id = 'proj1'`
  );
  db().exec(`
    INSERT INTO sessions (id, name, working_directory, project_id, worktree_path)
    VALUES ('s1', 'S1', '~/p1', 'proj1', NULL)
  `);
});

const row = () =>
  db()
    .prepare(
      "SELECT verify_status, verify_output, verify_ran_at FROM sessions WHERE id = 's1'"
    )
    .get() as {
    verify_status: string | null;
    verify_output: string | null;
    verify_ran_at: string | null;
  };

describe("decideSessionVerify (#19 — the turn-boundary matrix)", () => {
  const base = {
    prevStatus: "running" as string | undefined,
    currStatus: "idle",
    hasPrompt: false,
  };

  it("RUNS on a done boundary (running/waiting→idle, no prompt)", () => {
    expect(decideSessionVerify(base)).toBe("run");
    expect(decideSessionVerify({ ...base, prevStatus: "waiting" })).toBe("run");
  });

  it("CLEARS when a new turn starts (settled→running)", () => {
    expect(
      decideSessionVerify({
        ...base,
        prevStatus: "idle",
        currStatus: "running",
      })
    ).toBe("clear");
    expect(
      decideSessionVerify({
        ...base,
        prevStatus: "waiting",
        currStatus: "running",
      })
    ).toBe("clear");
  });

  it("does NOTHING on: first observation, unchanged status, prompt on screen", () => {
    expect(decideSessionVerify({ ...base, prevStatus: undefined })).toBe(
      "none"
    );
    expect(
      decideSessionVerify({ ...base, prevStatus: "idle", currStatus: "idle" })
    ).toBe("none");
    expect(decideSessionVerify({ ...base, hasPrompt: true })).toBe("none");
    // running→running (still working) is neither a boundary
    expect(
      decideSessionVerify({
        ...base,
        prevStatus: "running",
        currStatus: "running",
      })
    ).toBe("none");
  });
});

describe("sessionVerifyTick (#19 — end to end against an in-memory DB)", () => {
  const tick = (status: string, prompt?: string) =>
    sessionVerifyTick([{ id: "s1", status, prompt }]);

  it("runs the project's verify command on a done boundary and records the verdict", async () => {
    tick("running"); // first observation — none
    tick("idle"); // running→idle — RUN
    expect(row().verify_status).toBe("running"); // set synchronously
    await drain();
    expect(holder.verifyCalls).toHaveLength(1);
    expect(holder.verifyCalls[0].command).toBe("npm test");
    expect(row().verify_status).toBe("pass");
    expect(row().verify_ran_at).toBeTruthy();
  });

  it("records a FAIL verdict with the output tail", async () => {
    holder.verifyResult = { status: "fail", output: "1 test failed" };
    tick("running");
    tick("idle");
    await drain();
    expect(row().verify_status).toBe("fail");
    expect(row().verify_output).toBe("1 test failed");
  });

  it("clears the verdict when a new turn starts", async () => {
    tick("running");
    tick("idle");
    await drain();
    expect(row().verify_status).toBe("pass");
    tick("running"); // idle→running — CLEAR
    expect(row().verify_status).toBeNull();
    expect(row().verify_ran_at).toBeNull();
  });

  it("skips sessions whose project has NO verify command (and null projects)", async () => {
    db().exec(`UPDATE projects SET verify_command = NULL WHERE id = 'proj1'`);
    tick("running");
    tick("idle");
    await drain();
    expect(holder.verifyCalls).toHaveLength(0);
    expect(row().verify_status).toBeNull();

    db().exec(`UPDATE sessions SET project_id = NULL WHERE id = 's1'`);
    tick("running");
    tick("idle");
    await drain();
    expect(holder.verifyCalls).toHaveLength(0);
  });

  it("skips a done boundary that still shows a REAL prompt", async () => {
    tick("running");
    tick("idle", "Allow this command? [y/n]");
    await drain();
    expect(holder.verifyCalls).toHaveLength(0);
  });

  it("does not re-run without a new boundary (idle stays idle)", async () => {
    tick("running");
    tick("idle");
    await drain();
    tick("idle");
    tick("idle");
    await drain();
    expect(holder.verifyCalls).toHaveLength(1);
  });

  it("sweeps a stale 'running' row on the first tick after a restart (crash recovery)", async () => {
    db().exec(
      `UPDATE sessions SET verify_status = 'running', verify_output = NULL WHERE id = 's1'`
    );
    // _resetSessionVerifyState simulated the restart (bootSwept = false); the
    // very first tick sweeps the orphaned 'running' verdict away.
    tick("idle");
    expect(row().verify_status).toBeNull();
  });

  it("uses the worktree as cwd when present, else the working directory", async () => {
    db().exec(`UPDATE sessions SET worktree_path = '~/wt' WHERE id = 's1'`);
    tick("running");
    tick("idle");
    await drain();
    expect(holder.verifyCalls[0].cwd.replace(/\\/g, "/")).toMatch(/\/wt$/);
  });

  it("caps concurrent verifies at VERIFY_MAX_CONCURRENT (skipped turn, not queued)", async () => {
    // three sessions all hitting a done boundary in the same tick
    db().exec(`
      INSERT INTO sessions (id, name, working_directory, project_id)
      VALUES ('s2', 'S2', '~/p1', 'proj1'), ('s3', 'S3', '~/p1', 'proj1')
    `);
    // Hold the builds open so the cap is observable.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { runVerify } = await import("@/lib/dispatch/verify");
    vi.mocked(runVerify).mockImplementation(async (cwd: string) => {
      holder.verifyCalls.push({ cwd, command: "npm test" });
      await gate;
      return { status: "pass" as const, output: "" };
    });
    const all = (status: string) =>
      sessionVerifyTick([
        { id: "s1", status },
        { id: "s2", status },
        { id: "s3", status },
      ]);
    all("running");
    all("idle");
    // default cap is 2 — the third session's turn is skipped (no 'running' row)
    expect(holder.verifyCalls.length).toBe(2);
    const running = db()
      .prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE verify_status = 'running'"
      )
      .get() as { n: number };
    expect(running.n).toBe(2);
    release();
    await drain();
  });
});
