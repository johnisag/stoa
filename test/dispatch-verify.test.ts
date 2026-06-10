import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Hoisted state for the mocked I/O ──────────────────────────────────────────
const { state } = vi.hoisted(() => ({
  state: {
    // execFile behaviour per step: "pass" | "fail" | "enoent" | "timeout"
    exec: "pass" as string,
    // verifyPass mocks:
    rows: [] as Array<Record<string, unknown>>,
    repo: { verify_gate: 1, verify_command: "npm run verify" } as
      | Record<string, unknown>
      | undefined,
    headRefOid: "sha-1" as string | null,
    live: [] as string[],
    sessions: {} as Record<string, { tmux_name: string }>,
    launches: [] as string[],
    setRunning: [] as Array<[string | null, string]>,
    tasks: [] as Promise<unknown>[],
  },
}));

// Mock child_process so promisify(execFile) is fully controllable (no real builds).
vi.mock("child_process", () => ({
  execFile: (
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (err: unknown, res?: { stdout: string; stderr: string }) => void
  ) => {
    if (state.exec === "pass") return cb(null, { stdout: "ok\n", stderr: "" });
    if (state.exec === "fail") {
      const e = Object.assign(new Error("nonzero"), {
        code: 1,
        stdout: "running tests\n",
        stderr: "AssertionError: 1 !== 2\n",
      });
      return cb(e);
    }
    if (state.exec === "enoent") {
      return cb(Object.assign(new Error("spawn"), { code: "ENOENT" }));
    }
    // timeout
    return cb(
      Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" })
    );
  },
}));
vi.mock("@/lib/platform", () => ({
  resolveBinary: (name: string) => (name === "missing" ? null : `/bin/${name}`),
  expandHome: (p: string) => p,
}));
vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    listPrOpen: () => ({ all: () => state.rows }),
    getDispatchRepo: () => ({ get: () => state.repo }),
    getSession: () => ({ get: (id: string) => state.sessions[id] }),
    setVerifyRunning: () => ({
      run: (sha: string | null, id: string) => state.setRunning.push([sha, id]),
    }),
    setVerifyResult: () => ({ run: () => {} }),
  },
}));
vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({ list: async () => state.live }),
}));
vi.mock("@/lib/dispatch/auto-merge", () => ({
  getPrReadiness: async () => ({ headRefOid: state.headRefOid }),
}));
// Capture the fire-and-forget launch + actually run the task (with mocked execFile)
// so its finally clears the module-level in-flight set between tests.
vi.mock("@/lib/async-operations", () => ({
  runInBackground: (task: () => Promise<void>, label: string) => {
    state.launches.push(label);
    state.tasks.push(Promise.resolve().then(task));
  },
}));

import {
  parseVerifySteps,
  summarizeVerifyExit,
  nextVerifyAction,
  runVerify,
  verifyPass,
} from "../lib/dispatch/verify";

describe("parseVerifySteps — the no-shell safety gate", () => {
  it("splits on && into argv steps", () => {
    expect(parseVerifySteps("npm run verify")).toEqual({
      steps: [["npm", "run", "verify"]],
    });
    expect(
      parseVerifySteps("npx tsc --noEmit && npm test && npm run build")
    ).toEqual({
      steps: [
        ["npx", "tsc", "--noEmit"],
        ["npm", "test"],
        ["npm", "run", "build"],
      ],
    });
  });

  it("keeps a double-quoted arg as one token", () => {
    expect(parseVerifySteps('vitest --filter "a b"')).toEqual({
      steps: [["vitest", "--filter", "a b"]],
    });
  });

  it("REJECTS every shell operator (no shell string ever reaches a process)", () => {
    for (const cmd of [
      "ls | grep x",
      "a; b",
      "echo $(whoami)",
      "build > out.txt",
      "cat < in",
      "a & b", // lone & (not the && delimiter)
      "echo `id`",
      "rm ${HOME}",
      "a (b)",
    ]) {
      const r = parseVerifySteps(cmd);
      expect("error" in r, `expected reject: ${cmd}`).toBe(true);
    }
  });

  it("rejects a newline, an empty command, an empty step, and an unterminated quote", () => {
    expect("error" in parseVerifySteps("npm test\nrm -rf /")).toBe(true);
    expect("error" in parseVerifySteps("")).toBe(true);
    expect("error" in parseVerifySteps("   ")).toBe(true);
    expect("error" in parseVerifySteps("npm test && && npm build")).toBe(true);
    expect("error" in parseVerifySteps('npm run "verify')).toBe(true);
  });
});

describe("summarizeVerifyExit", () => {
  it("maps a process outcome to a verdict", () => {
    expect(summarizeVerifyExit({ ok: true, code: 0, killed: false })).toBe(
      "pass"
    );
    expect(summarizeVerifyExit({ ok: false, code: 1, killed: false })).toBe(
      "fail"
    );
    expect(
      summarizeVerifyExit({ ok: false, code: "ENOENT", killed: false })
    ).toBe("error");
    expect(summarizeVerifyExit({ ok: false, code: null, killed: true })).toBe(
      "error"
    ); // timeout
  });
});

describe("nextVerifyAction", () => {
  const base = {
    verifyGate: true,
    status: "pr_open",
    prNumber: 7,
    headSha: "sha-1",
    verifyStatus: null as string | null,
    verifySha: null as string | null,
    inFlight: false,
    fixerAlive: false,
  };

  it("runs a fresh PR head", () => {
    expect(nextVerifyAction(base)).toBe("run");
  });

  it("idle when not an armed live-PR candidate or the head SHA is unknown", () => {
    expect(nextVerifyAction({ ...base, verifyGate: false })).toBe("idle");
    expect(nextVerifyAction({ ...base, status: "dispatched" })).toBe("idle");
    expect(nextVerifyAction({ ...base, prNumber: null })).toBe("idle");
    expect(nextVerifyAction({ ...base, headSha: null })).toBe("idle");
  });

  it("idle once THIS head is verified (terminal verdict, same SHA)", () => {
    for (const s of ["pass", "fail", "error"]) {
      expect(
        nextVerifyAction({ ...base, verifyStatus: s, verifySha: "sha-1" })
      ).toBe("idle");
    }
  });

  it("re-runs when the head MOVED (a fixer pushed)", () => {
    expect(
      nextVerifyAction({ ...base, verifyStatus: "pass", verifySha: "sha-OLD" })
    ).toBe("run");
  });

  it("waits while a verify is in-flight or a fixer is mid-push", () => {
    expect(nextVerifyAction({ ...base, inFlight: true })).toBe("wait");
    expect(nextVerifyAction({ ...base, fixerAlive: true })).toBe("wait");
  });

  it("crash recovery: a 'running' row with no in-flight build re-launches once", () => {
    expect(
      nextVerifyAction({
        ...base,
        verifyStatus: "running",
        verifySha: "sha-1",
        inFlight: false,
      })
    ).toBe("run");
  });
});

describe("runVerify (mocked execFile, no real build)", () => {
  beforeEach(() => {
    state.exec = "pass";
  });

  it("passes when every step exits 0", async () => {
    state.exec = "pass";
    const r = await runVerify("/wt", "npx tsc --noEmit && npm test");
    expect(r.status).toBe("pass");
  });

  it("fails with the failing step's output tail on a non-zero exit", async () => {
    state.exec = "fail";
    const r = await runVerify("/wt", "npm test");
    expect(r.status).toBe("fail");
    expect(r.output).toContain("npm test");
    expect(r.output).toContain("AssertionError");
  });

  it("errors (not fail) on a missing binary, a spawn ENOENT, or a timeout", async () => {
    expect((await runVerify("/wt", "missing --x")).status).toBe("error"); // resolveBinary null
    state.exec = "enoent";
    expect((await runVerify("/wt", "npm test")).status).toBe("error");
    state.exec = "timeout";
    const t = await runVerify("/wt", "npm test");
    expect(t.status).toBe("error");
    expect(t.output).toMatch(/timed out/i);
  });

  it("errors on a rejected (shell-operator) command without spawning anything", async () => {
    const r = await runVerify("/wt", "npm test | tee log");
    expect(r.status).toBe("error");
    expect(r.output).toMatch(/shell operators/i);
  });
});

describe("verifyPass", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "d1",
    repo_id: "r1",
    status: "pr_open",
    pr_number: 7,
    worktree_path: "/wt",
    verify_status: null,
    verify_sha: null,
    fixer_session_id: null,
    ci_fixer_session_id: null,
    rebase_fixer_session_id: null,
    ...over,
  });

  beforeEach(() => {
    state.rows = [row()];
    state.repo = { verify_gate: 1, verify_command: "npm run verify" };
    state.headRefOid = "sha-1";
    state.live = [];
    state.sessions = {};
    state.launches = [];
    state.setRunning = [];
    state.tasks = [];
    state.exec = "pass";
  });

  // Run verifyPass + drain the launched background task (clears the in-flight set).
  const runPass = async () => {
    await verifyPass();
    await Promise.all(state.tasks);
  };

  it("launches a verify for an armed repo's fresh PR head (running + SHA pinned)", async () => {
    await runPass();
    expect(state.launches).toEqual(["verify-d1"]);
    expect(state.setRunning).toEqual([["sha-1", "d1"]]); // sha pinned up-front
  });

  it("does nothing when the repo didn't arm verify_gate or has no command", async () => {
    state.repo = { verify_gate: 0, verify_command: "npm run verify" };
    await runPass();
    expect(state.launches).toHaveLength(0);
    state.repo = { verify_gate: 1, verify_command: null };
    await runPass();
    expect(state.launches).toHaveLength(0);
  });

  it("does nothing once THIS head is already verified", async () => {
    state.rows = [row({ verify_status: "pass", verify_sha: "sha-1" })];
    await runPass();
    expect(state.launches).toHaveLength(0);
  });

  it("re-launches when the head moved off the verified SHA", async () => {
    state.rows = [row({ verify_status: "pass", verify_sha: "sha-OLD" })];
    await runPass();
    expect(state.launches).toEqual(["verify-d1"]);
  });

  it("skips while a fixer is live on the row (don't verify a half-pushed tree)", async () => {
    state.rows = [row({ ci_fixer_session_id: "ci" })];
    state.sessions = { ci: { tmux_name: "tmux-ci" } };
    state.live = ["tmux-ci"];
    await runPass();
    expect(state.launches).toHaveLength(0);
  });

  it("defers when the head SHA can't be read (gh failed)", async () => {
    state.headRefOid = null;
    await runPass();
    expect(state.launches).toHaveLength(0);
  });
});
