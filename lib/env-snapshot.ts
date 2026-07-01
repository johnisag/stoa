/**
 * Warm environment snapshots (#14a).
 *
 * A fresh git worktree ships without node_modules, so every fan-out worktree pays
 * a cold `npm install` — the single biggest fan-out tax, and worst on Windows
 * where there's no copy-on-write. This caches a successfully-installed
 * `node_modules` keyed by the LOCKFILE CONTENT (+ platform + Node major) and copies
 * it into the next worktree that needs the same dependency set, skipping install.
 *
 * FAIL-OPEN by design: any miss, error, or unsupported case (a Windows path-length
 * limit, a pnpm symlink farm, a partial copy, a publish race) silently falls back
 * to a normal install. The cache can only make a launch FASTER, never break one.
 *
 * Snapshots live under `${STOA_HOME:-~/.stoa}/env-snapshots/<key>/` — one machine,
 * so a restore always lands on the platform + Node ABI it was captured on. The
 * manifest still stamps platform + Node major so a Node upgrade (same lockfile,
 * new native ABI) invalidates the stale cache instead of restoring broken bindings.
 *
 * Caveat: only node_modules is snapshotted. A postinstall that writes OUTSIDE
 * node_modules (rare) is not reproduced by a restore; set STOA_ENV_SNAPSHOTS=0 to
 * disable if a project depends on that.
 */

import * as fs from "fs";
import * as path from "path";
import { createHash, randomBytes } from "crypto";
import { homeDir } from "./platform";

const SNAPSHOT_VERSION = 1;
const MANIFEST_NAME = ".stoa-snapshot.json";
/** Keep at most this many published snapshots (LRU by mtime); older ones pruned.
 *  A snapshot is roughly the size of one project's node_modules (~hundreds of MB),
 *  so this bounds the cache's worst-case disk footprint. */
const MAX_SNAPSHOTS = 8;
/** An orphaned `.tmp-*` (a capture whose process was killed mid-copy) is reaped
 *  once older than this. A live capture finishes in seconds-to-minutes, so a full
 *  day never races one in flight even under clock skew. */
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;

/**
 * Lockfiles in install-priority order — MUST mirror `detectPackageManager()` in
 * env-setup.ts so the snapshot key is derived from the same lockfile that drives
 * the install it replaces.
 */
export const LOCKFILES = [
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
] as const;

export interface SnapshotManifest {
  version: number;
  lockFile: string;
  lockHash: string;
  platform: NodeJS.Platform;
  nodeMajor: number;
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O) — unit-tested.
// ---------------------------------------------------------------------------

/** Snapshots are on by default; STOA_ENV_SNAPSHOTS=0 is the opt-out escape hatch. */
export function snapshotsEnabled(): boolean {
  return process.env.STOA_ENV_SNAPSHOTS !== "0";
}

/** sha256 (hex) of a lockfile's raw bytes — uniform for text and binary (bun) lockfiles. */
export function hashLockfile(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The running Node major version (native-ABI boundary), e.g. 24. */
export function nodeMajor(): number {
  return parseInt(process.versions.node.split(".")[0], 10) || 0;
}

/** A filesystem-safe snapshot dir name. Content-addressed: identical dependency
 *  sets across repos dedupe to one snapshot; a Node/platform change never collides
 *  with a mismatched native ABI. The format version leads the key so a bump orphans
 *  old snapshots (they become unreferenced → LRU-pruned) instead of colliding with
 *  a same-key capture that could never replace them. */
export function snapshotKey(input: {
  lockHash: string;
  platform: NodeJS.Platform;
  nodeMajor: number;
}): string {
  return `v${SNAPSHOT_VERSION}-${input.platform}-node${input.nodeMajor}-${input.lockHash.slice(0, 24)}`;
}

/** Whether a manifest matches what we need NOW (version, deps, platform, ABI). */
export function isSnapshotFresh(
  manifest: SnapshotManifest | null | undefined,
  want: { lockHash: string; platform: NodeJS.Platform; nodeMajor: number }
): boolean {
  return (
    !!manifest &&
    manifest.version === SNAPSHOT_VERSION &&
    manifest.lockHash === want.lockHash &&
    manifest.platform === want.platform &&
    manifest.nodeMajor === want.nodeMajor
  );
}

/** Given snapshot dirs with mtimes, return the names to delete to keep only the
 *  `keep` most-recent. Pure → tested. */
export function snapshotsToPrune(
  entries: Array<{ name: string; mtimeMs: number }>,
  keep = MAX_SNAPSHOTS
): string[] {
  return [...entries]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(keep)
    .map((e) => e.name);
}

// ---------------------------------------------------------------------------
// I/O.
// ---------------------------------------------------------------------------

function snapshotsRoot(): string {
  // Match lib/db/index.ts: honor STOA_HOME so snapshots relocate with the rest of
  // Stoa's per-user home (and tests can redirect it to a scratch dir).
  const stoaHome = process.env.STOA_HOME || path.join(homeDir(), ".stoa");
  return path.join(stoaHome, "env-snapshots");
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Read + hash the worktree's lockfile (first match, install-priority order). */
export function readWorktreeLock(
  worktreePath: string
): { file: string; hash: string } | null {
  for (const file of LOCKFILES) {
    const p = path.join(worktreePath, file);
    try {
      if (fs.existsSync(p)) {
        return { file, hash: hashLockfile(fs.readFileSync(p)) };
      }
    } catch {
      // Unreadable — treat as absent and try the next candidate.
    }
  }
  return null;
}

/** True when `dir/node_modules` exists and is non-empty. */
function hasNodeModules(dir: string): boolean {
  try {
    return fs.readdirSync(path.join(dir, "node_modules")).length > 0;
  } catch {
    return false;
  }
}

function readManifest(dir: string): SnapshotManifest | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dir, MANIFEST_NAME), "utf-8")
    ) as SnapshotManifest;
  } catch {
    return null;
  }
}

// Best-effort reflink: copy-on-write on APFS/Btrfs, a plain byte copy everywhere
// else (Windows). NOT _FORCE, which would throw where reflinks are unsupported.
const CP_OPTS = {
  recursive: true as const,
  force: true as const,
  errorOnExist: false as const,
  // Preserve symlinks as symlinks so a copied tree's relative links still resolve
  // within it (npm/yarn on Windows use shim FILES, not symlinks, so this is moot
  // there; a pnpm symlink farm on Windows may EPERM → fail-open to install).
  dereference: false as const,
  mode: fs.constants.COPYFILE_FICLONE,
};

/**
 * Copy a cached node_modules into the worktree when a FRESH snapshot exists for
 * its exact lockfile. Returns `{ restored:true }` when the caller may skip install.
 * Fail-open: any miss or error returns `restored:false` (with a partial copy wiped)
 * so the caller falls through to a normal install.
 */
export async function restoreSnapshot(
  worktreePath: string
): Promise<{ restored: boolean; key?: string; reason?: string }> {
  if (!snapshotsEnabled()) return { restored: false, reason: "disabled" };
  // Never clobber an existing install.
  if (hasNodeModules(worktreePath))
    return { restored: false, reason: "node_modules-present" };

  const lock = readWorktreeLock(worktreePath);
  if (!lock) return { restored: false, reason: "no-lockfile" };

  const want = {
    lockHash: lock.hash,
    platform: process.platform,
    nodeMajor: nodeMajor(),
  };
  const key = snapshotKey(want);
  const dir = path.join(snapshotsRoot(), key);

  if (!isSnapshotFresh(readManifest(dir), want) || !hasNodeModules(dir))
    return { restored: false, key, reason: "miss" };

  const dest = path.join(worktreePath, "node_modules");
  try {
    await fs.promises.cp(path.join(dir, "node_modules"), dest, CP_OPTS);
    return { restored: true, key };
  } catch (error) {
    // Fail-open: wipe any partial copy so the install branch starts clean.
    await fs.promises
      .rm(dest, { recursive: true, force: true })
      .catch(() => {});
    return { restored: false, key, reason: errMsg(error) };
  }
}

/**
 * Cache a worktree's installed node_modules for reuse by the next worktree with
 * the same lockfile. No-op when a fresh snapshot already exists. Publishes
 * atomically (copy to a unique temp dir, then rename) so a concurrent reader never
 * sees a half-written snapshot; first writer wins on a race. Best-effort — every
 * failure path returns `captured:false` and never throws.
 */
export async function captureSnapshot(
  worktreePath: string
): Promise<{ captured: boolean; key?: string; reason?: string }> {
  if (!snapshotsEnabled()) return { captured: false, reason: "disabled" };

  const lock = readWorktreeLock(worktreePath);
  if (!lock) return { captured: false, reason: "no-lockfile" };
  if (!hasNodeModules(worktreePath))
    return { captured: false, reason: "no-node_modules" };

  const want = {
    lockHash: lock.hash,
    platform: process.platform,
    nodeMajor: nodeMajor(),
  };
  const key = snapshotKey(want);
  const root = snapshotsRoot();
  const finalDir = path.join(root, key);

  if (isSnapshotFresh(readManifest(finalDir), want) && hasNodeModules(finalDir))
    return { captured: false, key, reason: "cached" };

  const tmpDir = path.join(
    root,
    `.tmp-${key}-${randomBytes(6).toString("hex")}`
  );
  try {
    await fs.promises.mkdir(root, { recursive: true });
    // Housekeeping on EVERY attempt (not just success): reap orphaned temps from
    // killed captures and LRU-evict old snapshots, so a run of failing captures
    // can't leak temps while waiting for the next success. Runs before our own
    // temp exists, so it never touches it.
    await pruneSnapshots(root).catch(() => {});
    await fs.promises.cp(
      path.join(worktreePath, "node_modules"),
      path.join(tmpDir, "node_modules"),
      CP_OPTS
    );
    const manifest: SnapshotManifest = {
      version: SNAPSHOT_VERSION,
      lockFile: lock.file,
      lockHash: lock.hash,
      platform: process.platform,
      nodeMajor: nodeMajor(),
      capturedAt: new Date().toISOString(),
    };
    await fs.promises.writeFile(
      path.join(tmpDir, MANIFEST_NAME),
      JSON.stringify(manifest, null, 2)
    );
    // Publish atomically: the rename IS the test-and-set. rename onto an existing
    // non-empty dir reliably fails (ENOTEMPTY on POSIX, EEXIST/EPERM on Windows),
    // so if a concurrent capture already published this key OURS loses — that's a
    // win for the other writer (both are equivalent installs), not an error. No
    // existsSync pre-check: that would be a TOCTOU.
    try {
      await fs.promises.rename(tmpDir, finalDir);
    } catch (renameErr) {
      // Discard our temp and stay fail-open — return, never throw (the caller
      // fire-and-forgets us). finalDir present ⇒ another writer won (benign);
      // absent ⇒ a genuine FS error, still just fall back to a normal install.
      await fs.promises
        .rm(tmpDir, { recursive: true, force: true })
        .catch(() => {});
      const reason = fs.existsSync(finalDir) ? "raced" : errMsg(renameErr);
      return { captured: false, key, reason };
    }
    return { captured: true, key };
  } catch (error) {
    await fs.promises
      .rm(tmpDir, { recursive: true, force: true })
      .catch(() => {});
    return { captured: false, key, reason: errMsg(error) };
  }
}

/** LRU-prune published snapshots to MAX_SNAPSHOTS and reap orphaned temps. */
async function pruneSnapshots(root: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(root);
  } catch {
    return;
  }
  const now = Date.now();
  const live: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    const full = path.join(root, name);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (name.startsWith(".tmp-")) {
      if (now - st.mtimeMs > STALE_TEMP_MS) {
        await fs.promises
          .rm(full, { recursive: true, force: true })
          .catch(() => {});
      }
      continue;
    }
    live.push({ name, mtimeMs: st.mtimeMs });
  }
  for (const name of snapshotsToPrune(live)) {
    await fs.promises
      .rm(path.join(root, name), { recursive: true, force: true })
      .catch(() => {});
  }
}
