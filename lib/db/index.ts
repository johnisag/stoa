import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { homeDir, expandHome } from "../platform";
import { createSchema } from "./schema";
import { runMigrations } from "./migrations";

// Re-export types and queries
export * from "./types";
export { queries, readAuditEvents, countAuditEvents } from "./queries";

/**
 * Resolve where the SQLite database lives. It MUST sit outside the repo clone so
 * a re-clone / `git reset` / reinstall of `~/.stoa/repo` can never destroy session
 * history — AND so the path doesn't depend on the launch cwd (a `stoa`-launched
 * server can have a cwd that isn't writable, where a relative `./stoa.db` fails to
 * open and 500s every DB route). Resolution order:
 *   1. An explicit `DB_PATH` (a leading `~` is expanded).
 *   2. The canonical `STOA_HOME/stoa.db` (`~/.stoa`, the per-user Stoa home where the
 *      pid/log already live) — the safe zero-config default.
 *   3. Back-compat: if no canonical DB exists yet but a legacy in-repo `./stoa.db`
 *      does, migrate it to the canonical location so an upgrade never orphans data.
 * Exported for tests. (Restores #147/#154, which a "return to June 5 stable" revert
 * had rolled back to the cwd-relative path — the macOS DB-500 regression.)
 */
export function resolveDbPath(): string {
  // An empty DB_PATH ("") is treated as unset. A relative DB_PATH is resolved from
  // process.cwd() at startup (better-sqlite3's behavior); prefer absolute.
  if (process.env.DB_PATH) return expandHome(process.env.DB_PATH);
  const stoaHome = process.env.STOA_HOME || path.join(homeDir(), ".stoa");
  const canonical = path.join(stoaHome, "stoa.db");
  const legacy = path.join(process.cwd(), "stoa.db");
  if (!fs.existsSync(canonical) && fs.existsSync(legacy)) {
    // Sticky migration: copy the legacy in-repo DB (all 3 SQLite parts) into the
    // canonical STOA_HOME location so this clone — and any sibling clone — converge
    // on ONE file. Best-effort: if the copy fails, keep using the legacy path.
    try {
      fs.mkdirSync(stoaHome, { recursive: true });
      // COPYFILE_EXCL: if another process created the canonical DB between the
      // existsSync check above and now (TOCTOU), don't clobber it.
      fs.copyFileSync(legacy, canonical, fs.constants.COPYFILE_EXCL);
      for (const suffix of ["-wal", "-shm"]) {
        if (fs.existsSync(legacy + suffix)) {
          fs.copyFileSync(legacy + suffix, canonical + suffix);
        }
      }
      return canonical;
    } catch {
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

  // The DB now defaults to STOA_HOME, which may not exist yet on a fresh box — and
  // the lock file (and the DB itself) is written into that directory below. Ensure
  // it exists. NOT wrapped in try/catch: mkdir(recursive) is a no-op when the dir
  // already exists, so it only throws on a genuine permission / read-only failure —
  // which must surface as a clear EPERM at startup. Swallowing it would make the
  // lock write below ENOENT and withInitLock retry forever (stack overflow).
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });

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

  // Acquire lock EXCLUSIVELY: flag 'wx' (O_EXCL) fails if the file already
  // exists, so a racing process actually loses the race and retries — the default
  // 'w' flag overwrites, making this mutual-exclusion (and the retry below) a no-op.
  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
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
    let db: Database.Database | undefined;
    try {
      db = new Database(DB_PATH, { timeout: 10000 });

      // Enable WAL mode for better concurrency
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 10000");

      // Create tables and indexes
      createSchema(db);

      // Run migrations
      runMigrations(db);

      return db;
    } catch (err) {
      // A failed open/schema/migration must not leak the DB handle.
      try {
        db?.close();
      } catch {}
      throw err;
    }
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
