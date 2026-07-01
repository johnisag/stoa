import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  LOCKFILES,
  hashLockfile,
  nodeMajor,
  snapshotKey,
  isSnapshotFresh,
  snapshotsToPrune,
  snapshotsEnabled,
  readWorktreeLock,
  restoreSnapshot,
  captureSnapshot,
  type SnapshotManifest,
} from "@/lib/env-snapshot";

// Redirect the snapshot store to a scratch dir via STOA_HOME (the same override
// lib/db honors), so capture/restore round-trip against a real filesystem without
// touching the user's ~/.stoa. Uses only regular files + nested dirs — no
// symlinks — so it runs identically on the Windows CI leg (symlinks need privilege).

const prevHome = process.env.STOA_HOME;
const prevEnabled = process.env.STOA_ENV_SNAPSHOTS;
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stoa-snap-"));
  process.env.STOA_HOME = path.join(tmp, "home");
  delete process.env.STOA_ENV_SNAPSHOTS;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.STOA_HOME;
  else process.env.STOA_HOME = prevHome;
  if (prevEnabled === undefined) delete process.env.STOA_ENV_SNAPSHOTS;
  else process.env.STOA_ENV_SNAPSHOTS = prevEnabled;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Build a fake worktree: a package-lock.json + a small node_modules tree. */
function makeWorktree(
  lock: string,
  modules: Record<string, string>,
  { withModules = true } = {}
): string {
  const wt = fs.mkdtempSync(path.join(tmp, "wt-"));
  fs.writeFileSync(path.join(wt, "package-lock.json"), lock);
  if (withModules) {
    for (const [rel, content] of Object.entries(modules)) {
      const full = path.join(wt, "node_modules", rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  return wt;
}

const SAMPLE = {
  "left-pad/index.js": "module.exports = () => {};",
  "left-pad/package.json": '{"name":"left-pad"}',
  ".bin/tsc.cmd": "@echo off\r\nnode tsc.js",
};

describe("env-snapshot pure helpers", () => {
  it("hashLockfile is deterministic and content-sensitive", () => {
    expect(hashLockfile("abc")).toBe(hashLockfile("abc"));
    expect(hashLockfile("abc")).not.toBe(hashLockfile("abcd"));
    // hashes raw bytes uniformly (works for binary bun.lockb)
    expect(hashLockfile(Buffer.from([1, 2, 3]))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("snapshotKey is stable for the same inputs and varies by lockHash/platform/node", () => {
    const base = {
      lockHash: "deadbeef".repeat(8),
      platform: "linux" as const,
      nodeMajor: 24,
    };
    expect(snapshotKey(base)).toBe(snapshotKey(base));
    expect(snapshotKey(base)).not.toBe(
      snapshotKey({ ...base, platform: "win32" })
    );
    expect(snapshotKey(base)).not.toBe(snapshotKey({ ...base, nodeMajor: 22 }));
    expect(snapshotKey(base)).not.toBe(
      snapshotKey({ ...base, lockHash: "cafe".repeat(16) })
    );
    // filesystem-safe (no path separators / colons)
    expect(snapshotKey(base)).not.toMatch(/[/\\:]/);
    // format version leads the key so a bump orphans (not collides with) old dirs
    expect(snapshotKey(base)).toMatch(/^v\d+-/);
  });

  it("isSnapshotFresh matches only on version + deps + platform + ABI", () => {
    const want = { lockHash: "h1", platform: "linux" as const, nodeMajor: 24 };
    const m: SnapshotManifest = {
      version: 1,
      lockFile: "package-lock.json",
      lockHash: "h1",
      platform: "linux",
      nodeMajor: 24,
      capturedAt: "2026-07-01T00:00:00Z",
    };
    expect(isSnapshotFresh(m, want)).toBe(true);
    expect(isSnapshotFresh(null, want)).toBe(false);
    expect(isSnapshotFresh({ ...m, version: 2 }, want)).toBe(false);
    expect(isSnapshotFresh({ ...m, lockHash: "h2" }, want)).toBe(false);
    expect(isSnapshotFresh({ ...m, platform: "win32" }, want)).toBe(false);
    expect(isSnapshotFresh({ ...m, nodeMajor: 22 }, want)).toBe(false);
  });

  it("snapshotsToPrune keeps the N most-recent and returns the rest", () => {
    const entries = [
      { name: "a", mtimeMs: 100 },
      { name: "b", mtimeMs: 300 },
      { name: "c", mtimeMs: 200 },
    ];
    expect(snapshotsToPrune(entries, 2).sort()).toEqual(["a"]);
    expect(snapshotsToPrune(entries, 5)).toEqual([]);
    expect(snapshotsToPrune(entries, 0).sort()).toEqual(["a", "b", "c"]);
  });

  it("LOCKFILES mirror detectPackageManager priority (bun > pnpm > yarn > npm)", () => {
    expect([...LOCKFILES]).toEqual([
      "bun.lockb",
      "pnpm-lock.yaml",
      "yarn.lock",
      "package-lock.json",
    ]);
  });

  it("snapshotsEnabled is on by default, off only for STOA_ENV_SNAPSHOTS=0", () => {
    delete process.env.STOA_ENV_SNAPSHOTS;
    expect(snapshotsEnabled()).toBe(true);
    process.env.STOA_ENV_SNAPSHOTS = "1";
    expect(snapshotsEnabled()).toBe(true);
    process.env.STOA_ENV_SNAPSHOTS = "0";
    expect(snapshotsEnabled()).toBe(false);
  });
});

describe("readWorktreeLock", () => {
  it("reads + hashes the present lockfile", () => {
    const wt = makeWorktree("LOCK-CONTENT", SAMPLE);
    const lock = readWorktreeLock(wt);
    expect(lock).toEqual({
      file: "package-lock.json",
      hash: hashLockfile("LOCK-CONTENT"),
    });
  });

  it("returns null when no lockfile exists", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "nolock-"));
    expect(readWorktreeLock(dir)).toBeNull();
  });
});

describe("captureSnapshot → restoreSnapshot round-trip", () => {
  it("captures an installed node_modules and restores it into a fresh worktree", async () => {
    const src = makeWorktree("LOCK-A", SAMPLE);
    const cap = await captureSnapshot(src);
    expect(cap.captured).toBe(true);
    expect(cap.key).toBeTruthy();

    // snapshot dir + manifest exist under STOA_HOME/env-snapshots/<key>
    const snapDir = path.join(
      process.env.STOA_HOME!,
      "env-snapshots",
      cap.key!
    );
    expect(fs.existsSync(path.join(snapDir, ".stoa-snapshot.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(snapDir, "node_modules", "left-pad", "index.js"))
    ).toBe(true);

    // a SECOND fresh worktree with the same lockfile restores from the snapshot
    const dst = makeWorktree("LOCK-A", {}, { withModules: false });
    const res = await restoreSnapshot(dst);
    expect(res.restored).toBe(true);
    expect(res.key).toBe(cap.key);
    expect(
      fs.readFileSync(
        path.join(dst, "node_modules", "left-pad", "index.js"),
        "utf-8"
      )
    ).toBe(SAMPLE["left-pad/index.js"]);
    // nested + .bin shim files copied recursively
    expect(
      fs.existsSync(path.join(dst, "node_modules", ".bin", "tsc.cmd"))
    ).toBe(true);
  });

  it("MISSES restore when the lockfile content differs", async () => {
    const src = makeWorktree("LOCK-A", SAMPLE);
    await captureSnapshot(src);
    const dst = makeWorktree("LOCK-B-different", {}, { withModules: false });
    const res = await restoreSnapshot(dst);
    expect(res.restored).toBe(false);
    expect(res.reason).toBe("miss");
    expect(fs.existsSync(path.join(dst, "node_modules"))).toBe(false);
  });

  it("restore is a no-op (fail-open) when no snapshot exists at all", async () => {
    const dst = makeWorktree("LOCK-NEW", {}, { withModules: false });
    const res = await restoreSnapshot(dst);
    expect(res.restored).toBe(false);
    expect(fs.existsSync(path.join(dst, "node_modules"))).toBe(false);
  });

  it("does not clobber an existing node_modules", async () => {
    const src = makeWorktree("LOCK-A", SAMPLE);
    await captureSnapshot(src);
    const dst = makeWorktree("LOCK-A", { "own/marker.js": "MINE" });
    const res = await restoreSnapshot(dst);
    expect(res.restored).toBe(false);
    expect(res.reason).toBe("node_modules-present");
    // the worktree's own node_modules is untouched
    expect(
      fs.readFileSync(
        path.join(dst, "node_modules", "own", "marker.js"),
        "utf-8"
      )
    ).toBe("MINE");
  });

  it("capture is idempotent — a second capture of the same key is skipped", async () => {
    const src = makeWorktree("LOCK-A", SAMPLE);
    expect((await captureSnapshot(src)).captured).toBe(true);
    const again = await captureSnapshot(src);
    expect(again.captured).toBe(false);
    expect(again.reason).toBe("cached");
  });

  it("capture skips a worktree with no lockfile and one with no node_modules", async () => {
    const noLock = fs.mkdtempSync(path.join(tmp, "nolock-"));
    fs.mkdirSync(path.join(noLock, "node_modules"));
    fs.writeFileSync(path.join(noLock, "node_modules", "x.js"), "x");
    expect((await captureSnapshot(noLock)).reason).toBe("no-lockfile");

    const noMods = makeWorktree("LOCK-A", {}, { withModules: false });
    expect((await captureSnapshot(noMods)).reason).toBe("no-node_modules");
  });
});

describe("STOA_ENV_SNAPSHOTS=0 kill switch", () => {
  it("disables both capture and restore", async () => {
    process.env.STOA_ENV_SNAPSHOTS = "0";
    const src = makeWorktree("LOCK-A", SAMPLE);
    expect((await captureSnapshot(src)).reason).toBe("disabled");
    const dst = makeWorktree("LOCK-A", {}, { withModules: false });
    expect((await restoreSnapshot(dst)).reason).toBe("disabled");
    expect(fs.existsSync(path.join(dst, "node_modules"))).toBe(false);
  });
});

describe("nodeMajor", () => {
  it("returns the running Node major as a positive integer", () => {
    expect(nodeMajor()).toBe(parseInt(process.versions.node.split(".")[0], 10));
    expect(nodeMajor()).toBeGreaterThan(0);
  });
});
