import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Hoisted state for the mocked I/O ──────────────────────────────────────────
const { state } = vi.hoisted(() => ({
  state: {
    // Verification child behaviour, including leaked-pipe limit regressions.
    exec: "pass" as string,
    ps: "success" as "success" | "error" | "timeout",
    psAvailable: true,
    // verifyPass mocks:
    rows: [] as Array<Record<string, unknown>>,
    repo: { verify_gate: 1, verify_command: "npm run verify" } as
      Record<string, unknown> | undefined,
    headRefOid: "sha-1" as string | null,
    live: [] as string[],
    sessions: {} as Record<string, { tmux_name: string }>,
    launches: [] as string[],
    setRunning: [] as Array<[string | null, string]>,
    cleared: [] as string[],
    tasks: [] as Promise<unknown>[],
    onWindows: false,
    resolvedBin: null as string | null,
    spawned: [] as Array<{
      file: string;
      args: string[];
      options: Record<string, unknown>;
    }>,
    failStdout: "running tests\n",
    failStderr: "AssertionError: 1 !== 2\n",
    killCalls: 0,
    destroyedStreams: 0,
    unrefedStreams: 0,
    unrefedChildren: 0,
    emitClose: null as (() => void) | null,
  },
}));

// Mock child_process so the owned spawn/process-group runner is fully
// controllable here. Real descendant teardown has its own integration test.
vi.mock("child_process", () => ({
  execFile: (
    _file: string,
    _args: string[],
    options: Record<string, unknown>,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    if (state.ps === "timeout") {
      setTimeout(
        () => callback(new Error("ps timed out"), "", ""),
        Number(options.timeout ?? 0)
      );
    } else {
      queueMicrotask(() =>
        callback(state.ps === "error" ? new Error("ps failed") : null, "", "")
      );
    }
    return {};
  },
  spawn: (file: string, args: string[], options: Record<string, unknown>) => {
    state.spawned.push({ file, args, options });
    const childListeners = new Map<string, (...values: unknown[]) => void>();
    const stdoutListeners = new Map<string, (value: Buffer | string) => void>();
    const stderrListeners = new Map<string, (value: Buffer | string) => void>();
    const stream = (
      listeners: Map<string, (value: Buffer | string) => void>
    ) => ({
      on: (event: string, listener: (value: Buffer | string) => void) => {
        listeners.set(event, listener);
      },
      destroy: () => {
        state.destroyedStreams += 1;
      },
      unref: () => {
        state.unrefedStreams += 1;
      },
    });
    const child = {
      pid: state.exec === "enoent" ? undefined : 987_654,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdout: stream(stdoutListeners),
      stderr: stream(stderrListeners),
      once: (event: string, listener: (...values: unknown[]) => void) => {
        childListeners.set(event, listener);
        return child;
      },
      kill: () => {
        state.killCalls += 1;
        child.signalCode = "SIGKILL";
        if (!state.exec.endsWith("-no-close")) {
          queueMicrotask(() => childListeners.get("close")?.(null, "SIGKILL"));
        }
        return true;
      },
      unref: () => {
        state.unrefedChildren += 1;
      },
    };
    state.emitClose = () => childListeners.get("close")?.(null, "SIGKILL");
    queueMicrotask(() => {
      if (state.exec === "pass") {
        stdoutListeners.get("data")?.("ok\n");
        child.exitCode = 0;
        childListeners.get("close")?.(0, null);
      } else if (state.exec === "fail") {
        stdoutListeners.get("data")?.(state.failStdout);
        stderrListeners.get("data")?.(state.failStderr);
        child.exitCode = 1;
        childListeners.get("close")?.(1, null);
      } else if (state.exec === "enoent") {
        childListeners.get("error")?.(
          Object.assign(new Error("spawn"), { code: "ENOENT" })
        );
        childListeners.get("close")?.(null, null);
      } else if (
        state.exec === "maxbuffer" ||
        state.exec === "maxbuffer-no-close"
      ) {
        stdoutListeners.get("data")?.(Buffer.alloc(128, "x"));
      }
      // The timeout case deliberately stays open until the runner kills it.
    });
    return child;
  },
}));
vi.mock("@/lib/platform", () => ({
  resolveBinary: (name: string) =>
    name === "missing" || (name === "ps" && !state.psAvailable)
      ? null
      : (state.resolvedBin ?? `/bin/${name}`),
  expandHome: (p: string) => p,
  get isWindows() {
    return state.onWindows;
  },
  killTreeArgs: (pid: number, onWindows: boolean) =>
    onWindows ? ["taskkill", "/PID", String(pid), "/T", "/F"] : null,
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
    clearVerify: () => ({ run: (id: string) => state.cleared.push(id) }),
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
  nextVerifyAction,
  parseVerifySteps as dispatchParseVerifySteps,
  runVerify as dispatchRunVerify,
  spawnArgs as dispatchSpawnArgs,
  verifyPass,
} from "../lib/dispatch/verify";
import {
  buildVerificationEnvironment,
  parseVerifySteps,
  runVerify,
  spawnArgs,
  summarizeVerifyExit,
  VERIFY_MAX_OUTPUT_BUFFER,
  VERIFY_OUTPUT_TAIL_MAX,
  VERIFY_TIMEOUT_MS,
} from "../lib/verification/runner";

describe("Dispatch verification adapter", () => {
  it("retains the existing parser, spawn, and runner exports", () => {
    expect(dispatchParseVerifySteps).toBe(parseVerifySteps);
    expect(dispatchSpawnArgs).toBe(spawnArgs);
    expect(dispatchRunVerify).toBe(runVerify);
  });
});

describe("spawnArgs — Windows .cmd routing (the must-fix)", () => {
  it("routes a .cmd/.bat shim through cmd.exe /c on Windows (no shell:true)", () => {
    const r = spawnArgs(
      "C:\\Program Files\\nodejs\\npm.cmd",
      ["run", "v"],
      true
    );
    expect(r.file.toLowerCase()).toContain("cmd"); // ComSpec / cmd.exe
    expect(r.args).toEqual([
      "/c",
      "C:\\Program Files\\nodejs\\npm.cmd",
      "run",
      "v",
    ]);
    expect(spawnArgs("C:\\tools\\verify.bat", ["--quick"], true).args).toEqual([
      "/c",
      "C:\\tools\\verify.bat",
      "--quick",
    ]);
  });

  it("spawns directly for a non-shim binary, and never routes off Windows", () => {
    expect(spawnArgs("/usr/bin/node", ["x.js"], true)).toEqual({
      file: "/usr/bin/node",
      args: ["x.js"],
    });
    expect(spawnArgs("C:\\x\\npm.cmd", ["run"], false)).toEqual({
      file: "C:\\x\\npm.cmd",
      args: ["run"],
    });
  });
});

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
      "echo %PATH%", // cmd.exe expands % even quoted → reject (routing safety)
      'echo "%PATH%"',
      'vitest --filter "a&b"',
      'node -e "console.log($(whoami))"',
      "a ^ b", // cmd.exe escape
      "vitest --filter 'a b'", // single quotes unsupported → reject, don't mangle
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
    state.ps = "success";
    state.psAvailable = true;
    state.failStdout = "running tests\n";
    state.failStderr = "AssertionError: 1 !== 2\n";
    state.spawned = [];
    state.killCalls = 0;
    state.destroyedStreams = 0;
    state.unrefedStreams = 0;
    state.unrefedChildren = 0;
    state.emitClose = null;
  });

  it("passes when every step exits 0", async () => {
    state.exec = "pass";
    const r = await runVerify("/wt", "npx tsc --noEmit && npm test");
    expect(r.status).toBe("pass");
  });

  it("starts a detached no-shell process group for cross-platform tree teardown", async () => {
    await runVerify("/wt", "npm test");
    expect(state.spawned).toHaveLength(1);
    expect(state.spawned[0].options).toMatchObject({
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(VERIFY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(VERIFY_MAX_OUTPUT_BUFFER).toBeGreaterThan(0);
  });

  it("never gives repository-controlled verification server or provider authority", () => {
    const environment = buildVerificationEnvironment({
      PATH: "/safe/bin",
      SystemRoot: "C:\\Windows",
      LANG: "en_US.UTF-8",
      STOA_TOKEN: "stoa-secret",
      STOA_FLEET_SCHEDULER_TOKEN: "scheduler-secret",
      STOA_WEBHOOK_SECRET: "webhook-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENAI_API_KEY: "openai-secret",
      GITHUB_TOKEN: "github-secret",
      GH_TOKEN: "gh-secret",
      NPM_TOKEN: "registry-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      SSH_AUTH_SOCK: "/secret/agent.sock",
      DATABASE_URL: "postgres://credential@host/db",
      CI: "0",
      NODE_ENV: "test",
    });

    expect(environment).toEqual({
      CI: "1",
      NODE_ENV: "test",
      PATH: "/safe/bin",
      SystemRoot: "C:\\Windows",
      LANG: "en_US.UTF-8",
    });
  });

  it("fails with the failing step's output tail on a non-zero exit", async () => {
    state.exec = "fail";
    const r = await runVerify("/wt", "npm test");
    expect(r.status).toBe("fail");
    expect(r.output).toContain("npm test");
    expect(r.output).toContain("AssertionError");
  });

  it("persists only the bounded tail of failing output", async () => {
    state.exec = "fail";
    state.failStdout = `discarded-prefix-${"x".repeat(
      VERIFY_OUTPUT_TAIL_MAX + 100
    )}`;
    state.failStderr = "";
    const result = await runVerify("/wt", "npm test");
    expect(result.status).toBe("fail");
    expect(result.output).toContain("(truncated)");
    expect(result.output).not.toContain("discarded-prefix");
    expect(result.output.endsWith("x".repeat(VERIFY_OUTPUT_TAIL_MAX))).toBe(
      true
    );
  });

  it("errors (not fail) on a missing binary, a spawn ENOENT, or a timeout", async () => {
    expect((await runVerify("/wt", "missing --x")).status).toBe("error"); // resolveBinary null
    state.exec = "enoent";
    expect((await runVerify("/wt", "npm test")).status).toBe("error");
    state.exec = "timeout";
    const t = await runVerify("/wt", "npm test", { timeoutMs: 5 });
    expect(t.status).toBe("error");
    expect(t.output).toMatch(/timed out/i);
  });

  it.each(["missing", "error", "timeout"] as const)(
    "keeps POSIX timeout cleanup bounded when ps is %s",
    async (failure) => {
      state.exec = "timeout";
      state.psAvailable = failure !== "missing";
      state.ps = failure === "missing" ? "success" : failure;
      const started = Date.now();
      const result = await runVerify("/wt", "npm test", { timeoutMs: 5 });
      expect(result.status).toBe("error");
      expect(result.output).toMatch(/timed out/i);
      expect(Date.now() - started).toBeLessThan(1_500);
    }
  );

  it.each([
    ["timeout-no-close", { timeoutMs: 5 }, /timed out/i],
    [
      "maxbuffer-no-close",
      { timeoutMs: 5_000, maxOutputBuffer: 32 },
      /output exceeded/i,
    ],
  ] as const)(
    "finalizes a limited %s child whose inherited pipes never close",
    async (mode, options, expectedReason) => {
      state.exec = mode;
      let settlements = 0;
      const started = Date.now();
      const result = await runVerify("/wt", "npm test", options).then(
        (value) => {
          settlements += 1;
          return value;
        }
      );

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(result.status).toBe("error");
      expect(result.output).toMatch(expectedReason);
      expect(state.killCalls).toBe(1);
      expect(state.destroyedStreams).toBe(2);
      expect(state.unrefedStreams).toBe(2);
      expect(state.unrefedChildren).toBe(1);

      // A delayed close from a retained/released FD cannot rerun finalization or
      // produce a second observable settlement.
      state.emitClose?.();
      await Promise.resolve();
      expect(settlements).toBe(1);
      expect(state.destroyedStreams).toBe(2);
      expect(state.unrefedChildren).toBe(1);
    }
  );

  it("errors on a rejected (shell-operator) command without spawning anything", async () => {
    const r = await runVerify("/wt", "npm test | tee log");
    expect(r.status).toBe("error");
    expect(r.output).toMatch(/shell operators/i);
  });

  it("an over-limit build reads as 'error' with an honest message (not a misleading spawn error)", async () => {
    state.exec = "maxbuffer";
    const r = await runVerify("/wt", "npm test", { maxOutputBuffer: 32 });
    expect(r.status).toBe("error");
    expect(r.output).toMatch(/output exceeded/i);
    expect(r.output).not.toMatch(/spawn error/i);
  });

  it("routes a Windows .cmd shim through cmd.exe (the EINVAL fix) end-to-end", async () => {
    state.onWindows = true;
    state.resolvedBin = "C:\\Program Files\\nodejs\\npm.cmd";
    state.spawned = [];
    await runVerify("/wt", "npm run verify");
    expect(state.spawned).toHaveLength(1);
    expect(state.spawned[0].file.toLowerCase()).toContain("cmd");
    expect(state.spawned[0].args[0]).toBe("/c");
    state.onWindows = false;
    state.resolvedBin = null;
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
    state.cleared = [];
    state.spawned = [];
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

  it("clears a STALE verdict when the head moved off the verified SHA (even mid-fixer)", async () => {
    // A rebase fixer pushed: head is sha-2 but the row's 'pass' is for sha-1.
    state.headRefOid = "sha-2";
    state.rows = [
      row({
        verify_status: "pass",
        verify_sha: "sha-1",
        rebase_fixer_session_id: "rb",
      }),
    ];
    state.sessions = { rb: { tmux_name: "tmux-rb" } };
    state.live = ["tmux-rb"];
    await runPass();
    expect(state.cleared).toEqual(["d1"]); // stale 'pass' wiped
    expect(state.launches).toHaveLength(0); // fixer alive → don't launch yet
  });

  it("caps concurrent builds at VERIFY_MAX_CONCURRENT", async () => {
    // 5 armed, fresh PRs; default cap is 2 → only 2 launch this tick.
    state.rows = [1, 2, 3, 4, 5].map((n) => row({ id: `d${n}`, pr_number: n }));
    await verifyPass(); // don't drain — keep them "in flight" to hit the cap
    expect(state.launches.length).toBe(2);
    await Promise.all(state.tasks); // drain so the module set clears for later tests
  });
});
