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
  containerNameFor,
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

describe("containerNameFor", () => {
  it("derives a docker-safe name from a session key", () => {
    expect(containerNameFor("claude-abc123")).toBe("stoa-claude-abc123");
    // Illegal chars → dashes; leading non-alnum stripped.
    expect(containerNameFor("a/b c:d")).toBe("stoa-a-b-c-d");
  });
});

describe("computeContainerMounts", () => {
  it("maps worktree→/workspace, config dirs→/root/<base>, ~/.stoa→/root/.stoa", () => {
    const m = computeContainerMounts({
      worktree: "/home/u/wt",
      gitCommonDir: "/home/u/repo/.git",
      agentConfigDirs: ["/home/u/.claude", "/home/u/.codex"],
      stoaHome: "/home/u/.stoa",
    });
    expect(m).toEqual([
      { hostPath: "/home/u/wt", containerPath: CONTAINER_WORKDIR },
      { hostPath: "/home/u/repo/.git", containerPath: "/home/u/repo/.git" },
      {
        hostPath: "/home/u/.claude",
        containerPath: `${CONTAINER_HOME}/.claude`,
      },
      { hostPath: "/home/u/.codex", containerPath: `${CONTAINER_HOME}/.codex` },
      { hostPath: "/home/u/.stoa", containerPath: `${CONTAINER_HOME}/.stoa` },
    ]);
  });

  it("skips the git-common dir when it's a Windows host path (no identical container path)", () => {
    const m = computeContainerMounts({
      worktree: "C:\\Users\\u\\wt",
      gitCommonDir: "C:\\Users\\u\\repo\\.git",
      stoaHome: "C:\\Users\\u\\.stoa",
    });
    expect(m.some((x) => x.hostPath === "C:\\Users\\u\\repo\\.git")).toBe(
      false
    );
    // Worktree + stoa still mount (host path verbatim, container path POSIX).
    expect(m[0]).toEqual({
      hostPath: "C:\\Users\\u\\wt",
      containerPath: CONTAINER_WORKDIR,
    });
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
    name: "stoa-x",
    agentBinary: "claude",
    agentArgs: ["--dangerously-skip-permissions", "-p", "do it"],
  };

  it("emits the exact ephemeral-tty run argv (image before the agent command)", () => {
    expect(buildDockerRunArgs(base)).toEqual([
      "run",
      "--rm",
      "-i",
      "-t",
      "--init",
      "--name",
      "stoa-x",
      "--label",
      "stoa.session=1",
      "-v",
      "/home/u/wt:/workspace",
      "-v",
      "/home/u/.stoa:/root/.stoa:ro",
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

  it("keeps an untrusted worktree path as ONE discrete -v token (no shell, no split)", () => {
    const evil = "/tmp/a b; rm -rf ~ $(whoami)";
    const args = buildDockerRunArgs({
      ...base,
      mounts: [{ hostPath: evil, containerPath: "/workspace" }],
    });
    // The -v value is exactly one token; the metachars never become argv of their own.
    expect(args).toContain(`${evil}:/workspace`);
    expect(args.filter((t) => t === `${evil}:/workspace`)).toHaveLength(1);
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
