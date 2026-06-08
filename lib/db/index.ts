import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { homeDir, expandHome } from "../platform";
import { createSchema } from "./schema";
import { runMigrations } from "./migrations";

// Re-export types and queries
export * from "./types";
export { queries } from "./queries";

/**
 * Resolve where the SQLite database lives. It MUST sit outside the repo clone so
 * a re-clone / `git reset` / reinstall of `~/.stoa/repo` can never destroy
 * session history. Resolution order:
 *   1. An explicit `DB_PATH` (a leading `~` is expanded).
 *   2. The canonical `STOA_HOME/stoa.db` (`~/.stoa`, where token/vapid.json
 *      already live) — the safe zero-config default.
 *   3. Back-compat: if no canonical DB exists yet but a legacy in-repo
 *      `./stoa.db` does, keep using it so an upgrade never orphans existing data.
 * Exported for tests.
 */
export function resolveDbPath(): string {
  // An empty DB_PATH ("") is treated as unset. A relative DB_PATH is resolved
  // from process.cwd() at startup (better-sqlite3's behavior); prefer absolute.
  if (process.env.DB_PATH) return expandHome(process.env.DB_PATH);
  const stoaHome = process.env.STOA_HOME || path.join(homeDir(), ".stoa");
  const canonical = path.join(stoaHome, "stoa.db");
  const legacy = path.join(process.cwd(), "stoa.db");
  if (!fs.existsSync(canonical) && fs.existsSync(legacy)) {
    // Sticky migration: copy the legacy in-repo DB (all 3 SQLite parts) into the
    // canonical STOA_HOME location so this clone — and any sibling clone — both
    // converge on ONE file. Without this, once an empty canonical DB appears
    // (e.g. created by another clone), this populated legacy DB would be silently
    // shadowed. Best-effort: if the copy fails, keep using the legacy path.
    try {
      fs.mkdirSync(stoaHome, { recursive: true });
      // COPYFILE_EXCL: if another process created the canonical DB between the
      // existsSync check above and now (TOCTOU), don't clobber it — the catch
      // below then adopts that canonical instead of overwriting it with legacy.
      fs.copyFileSync(legacy, canonical, fs.constants.COPYFILE_EXCL);
      for (const suffix of ["-wal", "-shm"]) {
        if (fs.existsSync(legacy + suffix)) {
          fs.copyFileSync(legacy + suffix, canonical + suffix);
        }
      }
      return canonical;
    } catch {
      // Copy failed (race lost, perms): adopt canonical if it now exists, else
      // keep using the legacy path.
      return fs.existsSync(canonical) ? canonical : legacy;
    }
  }
  return canonical;
}

const DB_PATH = resolveDbPath();
const LOCK_PATH = DB_PATH + ".init-lock";

// Simple file-based lock for initialization
function withInitLock<T>(fn: () => T): T {
  const maxWait = 10000; // 10 seconds
  const start = Date.now();

  // The DB now defaults to STOA_HOME, which may not exist yet on a fresh box —
  // and the lock file is written into the same directory below. Ensure it exists.
  try {
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  } catch {}

  // Wait for lock to be available
  while (fs.existsSync(LOCK_PATH)) {
    if (Date.now() - start > maxWait) {
      // Stale lock, remove it
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch {}
      break;
    }
    // Busy wait (sync is fine here, this is initialization)
    const waitUntil = Date.now() + 100;
    while (Date.now() < waitUntil) {}
  }

  // Acquire lock
  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid));
  } catch {
    // Another process got it first, wait and retry
    return withInitLock(fn);
  }

  try {
    return fn();
  } finally {
    // Release lock
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {}
  }
}

// Initialize database with schema
export function initDb(): Database.Database {
  return withInitLock(() => {
    const db = new Database(DB_PATH, { timeout: 10000 });

    // Enable WAL mode for better concurrency
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 10000");

    // Create tables and indexes
    createSchema(db);

    // Run migrations
    runMigrations(db);

    return db;
  });
}

// Singleton database instance
let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = initDb();
  }
  return _db;
}

// Lazy getter - don't initialize on import
export const db = new Proxy({} as Database.Database, {
  get(_, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
