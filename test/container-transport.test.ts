/**
 * Container isolation transport (#47) — the pure docker-run argv builder, mount
 * policy, detection, and the decorator delegation. Contract: it NEVER runs a real
 * docker (detection injected / no daemon), the argv is discrete tokens (an
 * untrusted worktree path or image can't inject), and the transport rewrites ONLY
 * spawn/attachStream while forwarding the other 9 methods verbatim.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { detectContainerRuntime } from "@/lib/container/detect";
import { ContainerTransport } from "@/lib/session-backend/pty/container-transport";
import type { PtyTransport } from "@/lib/session-backend/pty/transport";
import type { SpawnSpec } from "@/lib/session-backend/pty/registry";
import {
  buildDockerRunArgs,
  isValidImageName,
} from "@/lib/container/docker-args";
import {
  assertSafeContainerStoaHome,
  computeContainerMounts,
  containerPathForMountedHostPath,
  containerPathUnderHome,
  CONTAINER_WORKDIR,
  CONTAINER_HOME,
  validateFleetWritableRootLayouts,
} from "@/lib/container/mounts";

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";
const TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("detectContainerRuntime (injected — no real docker)", () => {
  it("returns docker + path when present, null when absent", () => {
    expect(detectContainerRuntime(() => "/usr/bin/docker")).toEqual({
      runtime: "docker",
      path: "/usr/bin/docker",
    });
    expect(detectContainerRuntime(() => null)).toBeNull();
  });
});

describe("isValidImageName", () => {
  it("accepts registry/name:tag@digest shapes, rejects junk", () => {
    for (const ok of [
      "ubuntu",
      "node:22",
      "ghcr.io/acme/agent:1.2.3",
      "img@sha256:abc",
    ]) {
      expect(isValidImageName(ok)).toBe(true);
    }
    for (const bad of [
      "",
      undefined,
      null,
      "a b",
      "img;rm -rf",
      "$(x)",
      "a`b`",
    ]) {
      expect(isValidImageName(bad)).toBe(false);
    }
  });
});

describe("computeContainerMounts", () => {
  it("mounts only an exact Fleet attempt root, never the whole Stoa state root", () => {
    const attemptRoot = `/home/u/.stoa/fleet/${RUN_A}/${TASK_A}/1`;
    const m = computeContainerMounts({
      worktree: "/home/u/wt",
      gitCommonDir: "/home/u/repo/.git",
      // A DIRECT home child AND a NESTED one (Kilo) — both must land where the
      // in-container agent reads them.
      agentConfigDirs: ["/home/u/.claude", "/home/u/.config/kilo"],
      stoaHome: "/home/u/.stoa",
      homeDir: "/home/u",
      fleetWritableRoots: [attemptRoot],
    });
    expect(m).toEqual([
      { hostPath: "/home/u/wt", containerPath: CONTAINER_WORKDIR },
      { hostPath: "/home/u/repo/.git", containerPath: "/home/u/repo/.git" },
      {
        hostPath: "/home/u/.claude",
        containerPath: `${CONTAINER_HOME}/.claude`,
      },
      // NESTED dir preserves its home-relative path (regression: not /root/kilo).
      {
        hostPath: "/home/u/.config/kilo",
        containerPath: `${CONTAINER_HOME}/.config/kilo`,
      },
      {
        hostPath: attemptRoot,
        containerPath: `${CONTAINER_HOME}/.stoa/fleet/${RUN_A}/${TASK_A}/1`,
      },
    ]);
    expect(m.some((mount) => mount.hostPath === "/home/u/.stoa")).toBe(false);
  });

  it("skips the git-common dir when it's a Windows host path (no identical container path)", () => {
    const m = computeContainerMounts({
      worktree: "C:\\Users\\u\\wt",
      gitCommonDir: "C:\\Users\\u\\repo\\.git",
      agentConfigDirs: ["C:\\Users\\u\\.config\\kilo"],
      stoaHome: "C:\\Users\\u\\.stoa",
      homeDir: "C:\\Users\\u",
      fleetWritableRoots: [
        `C:\\Users\\u\\.stoa\\fleet-task-runtime\\${RUN_A}\\${TASK_A}\\1\\reviews`,
      ],
    });
    expect(m.some((x) => x.hostPath === "C:\\Users\\u\\repo\\.git")).toBe(
      false
    );
    // Worktree host path verbatim; container path POSIX. Windows nested config
    // dir still re-roots home-relative (backslashes normalized).
    expect(m[0]).toEqual({
      hostPath: "C:\\Users\\u\\wt",
      containerPath: CONTAINER_WORKDIR,
    });
    expect(
      m.find((x) => x.hostPath === "C:\\Users\\u\\.config\\kilo")?.containerPath
    ).toBe(`${CONTAINER_HOME}/.config/kilo`);
    expect(m[m.length - 1]).toEqual({
      hostPath: `C:\\Users\\u\\.stoa\\fleet-task-runtime\\${RUN_A}\\${TASK_A}\\1\\reviews`,
      containerPath: `${CONTAINER_HOME}/.stoa/fleet-task-runtime/${RUN_A}/${TASK_A}/1/reviews`,
    });
    expect(m.some((mount) => mount.hostPath === "C:\\Users\\u\\.stoa")).toBe(
      false
    );
  });

  it("keeps generic container sessions free of any Stoa-state mount", () => {
    const m = computeContainerMounts({
      worktree: "/home/u/wt",
      agentConfigDirs: ["/home/u/.claude"],
      stoaHome: "/home/u/.stoa",
      homeDir: "/home/u",
    });
    expect(m.some((mount) => mount.hostPath.includes(".stoa"))).toBe(false);
  });

  it.each([
    ["arbitrary authority child", "/home/u/.stoa/secrets"],
    ["shallow fleet path", `/home/u/.stoa/fleet/${RUN_A}/${TASK_A}`],
    [
      "shallow task-runtime path",
      `/home/u/.stoa/fleet-task-runtime/${RUN_A}/${TASK_A}/1`,
    ],
    [
      "descendant of a worker attempt",
      `/home/u/.stoa/fleet/${RUN_A}/${TASK_A}/1/reports`,
    ],
    [
      "reserved integration worktree",
      "/home/u/.stoa/fleet/integrations/0123456789abcdef0123",
    ],
    ["reserved worker namespace", "/home/u/.stoa/fleet/run/supervisor/1"],
  ])("rejects an unauthorized %s", (_name, root) => {
    expect(() =>
      validateFleetWritableRootLayouts([root], "/home/u/.stoa")
    ).toThrow(/exact server-owned attempt directory/i);
    expect(() =>
      computeContainerMounts({
        worktree: "/home/u/wt",
        stoaHome: "/home/u/.stoa",
        homeDir: "/home/u",
        fleetWritableRoots: [root],
      })
    ).toThrow(/exact server-owned attempt directory/i);
  });

  it("applies Windows layout semantics independent of the CI host", () => {
    const root = `C:\\Users\\u\\.stoa\\fleet\\${RUN_A}\\${TASK_A}\\1`;
    expect(
      validateFleetWritableRootLayouts([root], "C:\\Users\\u\\.stoa")
    ).toEqual([root]);
    expect(() =>
      validateFleetWritableRootLayouts(
        ["C:\\Users\\u\\.stoa\\Secrets"],
        "C:\\Users\\u\\.stoa"
      )
    ).toThrow(/exact server-owned attempt directory/i);
  });

  it("accepts the exact server-owned planner request layout", () => {
    const root = "/home/u/.stoa/fleet/run-1/planner/request-1";
    expect(validateFleetWritableRootLayouts([root], "/home/u/.stoa")).toEqual([
      root,
    ]);
  });

  it("preserves caller-chosen safe run and task identities", () => {
    const root = "/home/u/.stoa/fleet/run-1/task-1/1";
    expect(validateFleetWritableRootLayouts([root], "/home/u/.stoa")).toEqual([
      root,
    ]);
  });

  it.each([
    {
      name: "POSIX",
      home: "/home/u",
      stoaHome: "/srv/stoa-custom",
      report: "/srv/stoa-custom/fleet/run/task/1/report.json",
      container: "/root/stoa-custom/fleet/run/task/1/report.json",
    },
    {
      name: "Windows",
      home: "C:\\Users\\u",
      stoaHome: "D:\\stoa-custom",
      report: "D:\\stoa-custom\\fleet\\run\\task\\1\\report.json",
      container: "/root/stoa-custom/fleet/run/task/1/report.json",
    },
  ])(
    "maps a $name custom STOA_HOME artifact through its exact mount",
    (item) => {
      const containerRoot = containerPathUnderHome(item.stoaHome, item.home);
      expect(
        containerPathForMountedHostPath(item.report, {
          hostPath: item.stoaHome,
          containerPath: containerRoot,
        })
      ).toBe(item.container);
    }
  );
});

describe("assertSafeContainerStoaHome", () => {
  it.each([
    {
      name: "POSIX default child",
      stoaHome: "/home/u/.stoa",
      homeDir: "/home/u",
      worktree: "/home/u/repos/app",
      authorityPaths: ["/home/u/.claude", "/home/u/.config/kilo"],
    },
    {
      name: "POSIX dedicated custom root",
      stoaHome: "/srv/stoa-state",
      homeDir: "/home/u",
      worktree: "/srv/repos/app",
      authorityPaths: ["/home/u/.claude"],
    },
    {
      name: "POSIX managed worktree child",
      stoaHome: "/home/u/.stoa",
      homeDir: "/home/u",
      worktree: "/home/u/.stoa/worktrees/app-task",
      authorityPaths: ["/home/u/.claude"],
    },
    {
      name: "Windows default child",
      stoaHome: "C:\\Users\\u\\.stoa",
      homeDir: "C:\\Users\\u",
      worktree: "C:\\Users\\u\\repos\\app",
      authorityPaths: ["C:\\Users\\u\\.codex"],
    },
    {
      name: "Windows managed worktree child",
      stoaHome: "C:\\Users\\u\\.stoa",
      homeDir: "C:\\Users\\u",
      worktree: "C:\\Users\\u\\.stoa\\worktrees\\app-task",
      authorityPaths: ["C:\\Users\\u\\.codex"],
    },
    {
      name: "Windows dedicated custom root",
      stoaHome: "D:\\stoa-state",
      homeDir: "C:\\Users\\u",
      worktree: "D:\\repos\\app",
      authorityPaths: ["C:\\Users\\u\\.codex"],
    },
  ])("accepts a narrow $name", (input) => {
    expect(() => assertSafeContainerStoaHome(input)).not.toThrow();
  });

  it.each([
    ["POSIX filesystem root", "/", "/home/u", "/work/app", []],
    ["Windows drive root", "C:\\", "C:\\Users\\u", "D:\\work\\app", []],
    [
      "Windows UNC share root",
      "\\\\server\\share\\",
      "C:\\Users\\u",
      "D:\\work\\app",
      [],
    ],
    ["POSIX home", "/home/u", "/home/u", "/work/app", []],
    ["POSIX home ancestor", "/home", "/home/u", "/work/app", []],
    [
      "Windows case-insensitive home ancestor",
      "c:\\users",
      "C:\\Users\\u",
      "D:\\work\\app",
      [],
    ],
    ["POSIX workspace ancestor", "/srv", "/home/u", "/srv/repos/app", []],
    [
      "Windows workspace child",
      "D:\\repos\\app\\.stoa",
      "C:\\Users\\u",
      "D:\\repos\\app",
      [],
    ],
    [
      "provider authority ancestor",
      "/home/u/.config",
      "/home/u",
      "/work/app",
      ["/home/u/.config/kilo"],
    ],
  ])(
    "rejects a broad or overlapping %s",
    (_name, stoaHome, homeDir, worktree, authorityPaths) => {
      expect(() =>
        assertSafeContainerStoaHome({
          stoaHome: stoaHome as string,
          homeDir: homeDir as string,
          worktree: worktree as string,
          authorityPaths: authorityPaths as string[],
        })
      ).toThrow(/unsafe STOA_HOME/i);
    }
  );
});

describe("buildDockerRunArgs", () => {
  const base = {
    image: "agent:latest",
    mounts: [
      { hostPath: "/home/u/wt", containerPath: "/workspace" },
      {
        hostPath: "/home/u/.stoa",
        containerPath: "/root/.stoa",
        readonly: true,
      },
    ],
    workdir: "/workspace",
    env: { CONDUCTOR_SESSION_ID: "s1" },
    allowNet: true,
    sessionKey: "claude-x",
    agentBinary: "claude",
    agentArgs: ["--dangerously-skip-permissions", "-p", "do it"],
  };

  it("emits the exact ephemeral-tty run argv (field-safe --mount; image before the agent command)", () => {
    expect(buildDockerRunArgs(base)).toEqual([
      "run",
      "--rm",
      "-i",
      "-t",
      "--init",
      "--label",
      "stoa.session=claude-x",
      "--mount",
      "type=bind,src=/home/u/wt,dst=/workspace",
      "--mount",
      "type=bind,src=/home/u/.stoa,dst=/root/.stoa,readonly",
      "-w",
      "/workspace",
      "-e",
      "CONDUCTOR_SESSION_ID=s1",
      "agent:latest",
      "claude",
      "--dangerously-skip-permissions",
      "-p",
      "do it",
    ]);
  });

  it("adds --network none when net is denied", () => {
    const args = buildDockerRunArgs({ ...base, allowNet: false });
    const i = args.indexOf("--network");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("none");
    // Sits before the image (all flags precede the positional image + command).
    expect(i).toBeLessThan(args.indexOf("agent:latest"));
  });

  it("passes empty authority overlays into the container as explicit clears", () => {
    const args = buildDockerRunArgs({
      ...base,
      env: {
        STOA_TOKEN: "",
        CONDUCTOR_SESSION_ID: "",
        DB_PATH: "",
      },
    });
    expect(args).toContain("STOA_TOKEN=");
    expect(args).toContain("CONDUCTOR_SESSION_ID=");
    expect(args).toContain("DB_PATH=");
  });

  it("keeps an untrusted worktree path as ONE discrete --mount token (no shell, no split)", () => {
    const evil = "/tmp/a b; rm -rf ~ $(whoami)";
    const args = buildDockerRunArgs({
      ...base,
      mounts: [{ hostPath: evil, containerPath: "/workspace" }],
    });
    const token = `type=bind,src=${evil},dst=/workspace`;
    expect(args).toContain(token);
    expect(args.filter((t) => t === token)).toHaveLength(1);
  });

  it("a COLON in the host path can't shift a mount field (the -v misparse regression)", () => {
    // A POSIX path may legally contain ':' — with -v host:ctr this would inject a
    // spurious 3rd field (e.g. an :ro / :z option). --mount keeps src explicit.
    const colon = "/tmp/weird:path";
    const args = buildDockerRunArgs({
      ...base,
      mounts: [{ hostPath: colon, containerPath: "/workspace" }],
    });
    expect(args).toContain(`type=bind,src=${colon},dst=/workspace`);
    // No bare host:ctr token leaked.
    expect(args.some((t) => t.startsWith("-v"))).toBe(false);
  });

  it("a COMMA in the host path is CSV-QUOTED so it can't inject a mount field", () => {
    // getRepoName = path.basename (NOT slugified), so a project dir named `a,b`
    // reaches the mount src. An unquoted comma would split the --mount CSV
    // (e.g. `src=/a,readonly` injects a readonly flag → silent RO worktree).
    const comma = "/home/u/proj,readonly/wt";
    const args = buildDockerRunArgs({
      ...base,
      mounts: [{ hostPath: comma, containerPath: "/workspace" }],
    });
    const i = args.indexOf("--mount");
    // The src field is quoted as one CSV field: type=bind,"src=…,…",dst=/workspace
    expect(args[i + 1]).toBe(`type=bind,"src=${comma}",dst=/workspace`);
    // The raw comma never appears as a bare `readonly` field of its own.
    expect(args[i + 1]).not.toMatch(/,readonly,/);
  });
});

// A recording stub delegate — proves the decorator composes through the seam
// with NO real pty, registry, or docker.
function fakeDelegate() {
  const calls = {
    spawn: [] as { key: string; spec: SpawnSpec }[],
    kill: [] as string[],
    write: [] as { key: string; data: string }[],
  };
  const d: PtyTransport = {
    async spawn(key, spec) {
      calls.spawn.push({ key, spec });
    },
    async kill(key) {
      calls.kill.push(key);
    },
    async rename() {},
    async exists() {
      return true;
    },
    async list() {
      return [];
    },
    async listActivity() {
      return [];
    },
    async panePath() {
      return null;
    },
    async pid() {
      return 123;
    },
    async capture() {
      return "screen";
    },
    write(key, data) {
      calls.write.push({ key, data });
    },
    async attachStream() {
      return { snapshot: "", resize() {}, detach() {} };
    },
  };
  return { d, calls };
}

describe("ContainerTransport (decorator)", () => {
  it("mounts only an exact Fleet attempt directory under a custom STOA_HOME", async () => {
    const prior = process.env.STOA_HOME;
    const scratch = mkdtempSync(join(tmpdir(), "stoa-container-home-"));
    const customHome = join(scratch, "state");
    const worktree = join(scratch, "worktree");
    const attemptRoot = join(customHome, "fleet", RUN_A, TASK_A, "1");
    mkdirSync(attemptRoot, { recursive: true });
    mkdirSync(worktree);
    process.env.STOA_HOME = customHome;
    try {
      const { d, calls } = fakeDelegate();
      const ct = new ContainerTransport(d, "/usr/bin/docker", "agent:latest");
      await ct.spawn("claude-custom-home", {
        binary: "claude",
        args: [],
        cwd: worktree,
        fleetWritableRoots: [attemptRoot],
      });
      const args = calls.spawn[0].spec.args ?? [];
      const expectedSource = resolve(attemptRoot);
      const expectedTarget = `${containerPathUnderHome(
        resolve(customHome),
        homedir()
      )}/fleet/${RUN_A}/${TASK_A}/1`;
      expect(args).toContain(
        `type=bind,src=${expectedSource},dst=${expectedTarget}`
      );
      expect(args).not.toContain(
        `type=bind,src=${resolve(customHome)},dst=${containerPathUnderHome(
          resolve(customHome),
          homedir()
        )}`
      );
    } finally {
      if (prior === undefined) delete process.env.STOA_HOME;
      else process.env.STOA_HOME = prior;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("does not mount STOA_HOME for a generic container session", async () => {
    const prior = process.env.STOA_HOME;
    const scratch = mkdtempSync(join(tmpdir(), "stoa-container-generic-"));
    const customHome = join(scratch, "state");
    const worktree = join(scratch, "worktree");
    mkdirSync(customHome);
    mkdirSync(worktree);
    process.env.STOA_HOME = customHome;
    try {
      const { d, calls } = fakeDelegate();
      const ct = new ContainerTransport(d, "/usr/bin/docker", "agent:latest");
      await ct.spawn("claude-generic", {
        binary: "claude",
        args: [],
        cwd: worktree,
      });
      expect(calls.spawn[0].spec.args).not.toContain(
        expect.stringContaining(`src=${resolve(customHome)},`)
      );
    } finally {
      if (prior === undefined) delete process.env.STOA_HOME;
      else process.env.STOA_HOME = prior;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects an unauthorized STOA_HOME child before the Docker delegate", async () => {
    const prior = process.env.STOA_HOME;
    const scratch = mkdtempSync(join(tmpdir(), "stoa-container-forged-root-"));
    const customHome = join(scratch, "state");
    const worktree = join(scratch, "worktree");
    const secrets = join(customHome, "secrets");
    mkdirSync(secrets, { recursive: true });
    mkdirSync(worktree);
    process.env.STOA_HOME = customHome;
    try {
      const { d, calls } = fakeDelegate();
      const ct = new ContainerTransport(d, "/usr/bin/docker", "agent:latest");
      await expect(
        ct.spawn("claude-forged-root", {
          binary: "claude",
          args: [],
          cwd: worktree,
          fleetWritableRoots: [secrets],
        })
      ).rejects.toThrow(/exact server-owned attempt directory/i);
      expect(calls.spawn).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env.STOA_HOME;
      else process.env.STOA_HOME = prior;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a valid-looking Fleet root whose real target has an unauthorized layout", async () => {
    const prior = process.env.STOA_HOME;
    const scratch = mkdtempSync(join(tmpdir(), "stoa-container-root-link-"));
    const customHome = join(scratch, "state");
    const worktree = join(scratch, "worktree");
    const secrets = join(customHome, "secrets");
    const taskParent = join(customHome, "fleet", RUN_A, TASK_A);
    const linkedAttempt = join(taskParent, "1");
    mkdirSync(secrets, { recursive: true });
    mkdirSync(taskParent, { recursive: true });
    mkdirSync(worktree);
    symlinkSync(
      secrets,
      linkedAttempt,
      process.platform === "win32" ? "junction" : "dir"
    );
    process.env.STOA_HOME = customHome;
    try {
      const { d, calls } = fakeDelegate();
      const ct = new ContainerTransport(d, "/usr/bin/docker", "agent:latest");
      await expect(
        ct.spawn("claude-escaped-root-layout", {
          binary: "claude",
          args: [],
          cwd: worktree,
          fleetWritableRoots: [linkedAttempt],
        })
      ).rejects.toThrow(/exact server-owned attempt directory/i);
      expect(calls.spawn).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env.STOA_HOME;
      else process.env.STOA_HOME = prior;
      unlinkSync(linkedAttempt);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a Fleet root redirected to another valid run and task", async () => {
    const prior = process.env.STOA_HOME;
    const scratch = mkdtempSync(join(tmpdir(), "stoa-container-cross-run-"));
    const customHome = join(scratch, "state");
    const worktree = join(scratch, "worktree");
    const linkedParent = join(customHome, "fleet", RUN_A, TASK_A);
    const linkedAttempt = join(linkedParent, "1");
    const otherAttempt = join(customHome, "fleet", RUN_B, TASK_B, "1");
    mkdirSync(linkedParent, { recursive: true });
    mkdirSync(otherAttempt, { recursive: true });
    mkdirSync(worktree);
    symlinkSync(
      otherAttempt,
      linkedAttempt,
      process.platform === "win32" ? "junction" : "dir"
    );
    process.env.STOA_HOME = customHome;
    try {
      const { d, calls } = fakeDelegate();
      const ct = new ContainerTransport(d, "/usr/bin/docker", "agent:latest");
      await expect(
        ct.spawn("claude-cross-run-root", {
          binary: "claude",
          args: [],
          cwd: worktree,
          fleetWritableRoots: [linkedAttempt],
        })
      ).rejects.toThrow(/same server-owned attempt directory/i);
      expect(calls.spawn).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env.STOA_HOME;
      else process.env.STOA_HOME = prior;
      unlinkSync(linkedAttempt);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("fails before delegation when STOA_HOME resolves to the user home", async () => {
    const prior = process.env.STOA_HOME;
    process.env.STOA_HOME = homedir();
    try {
      const { d, calls } = fakeDelegate();
      const ct = new ContainerTransport(d, "/usr/bin/docker", "agent:latest");
      await expect(
        ct.spawn("claude-unsafe-home", {
          binary: "claude",
          args: [],
          cwd: resolve(tmpdir(), "stoa-safe-worktree"),
        })
      ).rejects.toThrow(/unsafe STOA_HOME/i);
      expect(calls.spawn).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env.STOA_HOME;
      else process.env.STOA_HOME = prior;
    }
  });

  it("rejects a custom STOA_HOME symlink or junction targeting the user home", async () => {
    const prior = process.env.STOA_HOME;
    const scratch = mkdtempSync(join(tmpdir(), "stoa-container-state-link-"));
    const linkedHome = join(scratch, "state-link");
    const worktree = join(scratch, "worktree");
    mkdirSync(worktree);
    symlinkSync(
      homedir(),
      linkedHome,
      process.platform === "win32" ? "junction" : "dir"
    );
    process.env.STOA_HOME = linkedHome;
    try {
      const { d, calls } = fakeDelegate();
      const ct = new ContainerTransport(d, "/usr/bin/docker", "agent:latest");
      await expect(
        ct.spawn("claude-unsafe-state-link", {
          binary: "claude",
          args: [],
          cwd: worktree,
        })
      ).rejects.toThrow(/unsafe STOA_HOME/i);
      expect(calls.spawn).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env.STOA_HOME;
      else process.env.STOA_HOME = prior;
      unlinkSync(linkedHome);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a managed-worktree symlink or junction escaping STOA_HOME", async () => {
    const prior = process.env.STOA_HOME;
    const scratch = mkdtempSync(
      join(tmpdir(), "stoa-container-worktree-link-")
    );
    const customHome = join(scratch, "state");
    const worktrees = join(customHome, "worktrees");
    const outside = join(scratch, "outside-worktree");
    const linkedWorktree = join(worktrees, "session-link");
    mkdirSync(worktrees, { recursive: true });
    mkdirSync(outside);
    symlinkSync(
      outside,
      linkedWorktree,
      process.platform === "win32" ? "junction" : "dir"
    );
    process.env.STOA_HOME = customHome;
    try {
      const { d, calls } = fakeDelegate();
      const ct = new ContainerTransport(d, "/usr/bin/docker", "agent:latest");
      await expect(
        ct.spawn("claude-escaped-worktree", {
          binary: "claude",
          args: [],
          cwd: linkedWorktree,
        })
      ).rejects.toThrow(/managed worktree escapes/i);
      expect(calls.spawn).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env.STOA_HOME;
      else process.env.STOA_HOME = prior;
      unlinkSync(linkedWorktree);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rewrites spawn into a `docker run` of the agent, delegating to the wrapped transport", async () => {
    const { d, calls } = fakeDelegate();
    const ct = new ContainerTransport(d, "/usr/bin/docker", "agent:latest");
    // A non-repo cwd → the git-common-dir resolve fails gracefully (null).
    await ct.spawn("claude-x", {
      binary: "claude",
      args: ["-p", "hi"],
      cwd: "/no/such/repo-xyz",
    });
    expect(calls.spawn).toHaveLength(1);
    const spec = calls.spawn[0].spec;
    expect(spec.binary).toBe("/usr/bin/docker"); // the docker CLI is the pty child
    expect(spec.args[0]).toBe("run");
    const imgIdx = spec.args.indexOf("agent:latest");
    expect(imgIdx).toBeGreaterThan(-1);
    // The agent command follows the image, verbatim.
    expect(spec.args.slice(imgIdx + 1)).toEqual(["claude", "-p", "hi"]);
  });

  it("forwards replacement-environment mode through the decorator", async () => {
    const { d, calls } = fakeDelegate();
    const ct = new ContainerTransport(d, "/usr/bin/docker", "agent:latest");
    await ct.spawn("profiled", {
      binary: "node",
      args: ["broker.js"],
      cwd: "/no/such/repo-profiled",
      env: { STOA_TEST_ALLOWED: "yes" },
      envMode: "replace",
    });

    expect(calls.spawn[0].spec).toMatchObject({
      binary: "/usr/bin/docker",
      env: { STOA_TEST_ALLOWED: "yes" },
      envMode: "replace",
    });
  });

  it("forwards the other methods verbatim to the delegate", async () => {
    const { d, calls } = fakeDelegate();
    const ct = new ContainerTransport(d, "/usr/bin/docker", "agent:latest");
    await ct.kill("k");
    ct.write("k", "hello");
    expect(await ct.pid("k")).toBe(123);
    expect(await ct.capture("k")).toBe("screen");
    expect(calls.kill).toEqual(["k"]);
    expect(calls.write).toEqual([{ key: "k", data: "hello" }]);
  });
});
