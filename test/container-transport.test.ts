/**
 * Container isolation transport (#47) — the pure docker-run argv builder, mount
 * policy, detection, and the decorator delegation. Contract: it NEVER runs a real
 * docker (detection injected / no daemon), the argv is discrete tokens (an
 * untrusted worktree path or image can't inject), and the transport rewrites ONLY
 * spawn/attachStream while forwarding the other 9 methods verbatim.
 */
import { describe, it, expect } from "vitest";
import { detectContainerRuntime } from "@/lib/container/detect";
import { ContainerTransport } from "@/lib/session-backend/pty/container-transport";
import type { PtyTransport } from "@/lib/session-backend/pty/transport";
import type { SpawnSpec } from "@/lib/session-backend/pty/registry";
import {
  buildDockerRunArgs,
  isValidImageName,
} from "@/lib/container/docker-args";
import {
  computeContainerMounts,
  CONTAINER_WORKDIR,
  CONTAINER_HOME,
} from "@/lib/container/mounts";

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
  it("maps worktree→/workspace, home-relative config/state dirs under /root", () => {
    const m = computeContainerMounts({
      worktree: "/home/u/wt",
      gitCommonDir: "/home/u/repo/.git",
      // A DIRECT home child AND a NESTED one (Kilo) — both must land where the
      // in-container agent reads them.
      agentConfigDirs: ["/home/u/.claude", "/home/u/.config/kilo"],
      stoaHome: "/home/u/.stoa",
      homeDir: "/home/u",
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
      { hostPath: "/home/u/.stoa", containerPath: `${CONTAINER_HOME}/.stoa` },
    ]);
  });

  it("skips the git-common dir when it's a Windows host path (no identical container path)", () => {
    const m = computeContainerMounts({
      worktree: "C:\\Users\\u\\wt",
      gitCommonDir: "C:\\Users\\u\\repo\\.git",
      agentConfigDirs: ["C:\\Users\\u\\.config\\kilo"],
      stoaHome: "C:\\Users\\u\\.stoa",
      homeDir: "C:\\Users\\u",
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
    expect(m[m.length - 1].containerPath).toBe(`${CONTAINER_HOME}/.stoa`);
  });
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
