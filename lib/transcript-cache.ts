/**
 * Stat-gated, LRU-bounded cache for values derived from a file (#18).
 *
 * Keyed by file PATH; an entry is served only while the file's mtime AND size are
 * BOTH unchanged since it was cached — so any append (size grows) or a
 * truncation/`/compact` (size shrinks, mtime moves) invalidates it. Gating on both
 * is deliberate: size alone would miss an in-place rewrite, and mtime alone would
 * miss a truncation landing in the same coarse mtime bucket (Windows mtime is
 * low-resolution) or a same-mtime re-append.
 *
 * The single expensive thing this exists to avoid is re-reading + re-parsing large
 * append-only transcript JSONL on every budget/sampler/monitor tick — Stoa's
 * biggest avoidable steady-state CPU/IO. `stat` and `load` are INJECTED so the
 * cache logic is unit-tested against a fake filesystem (no real I/O), and so a
 * second consumer (e.g. output search) can reuse the same primitive with a
 * different value type.
 */

export interface StatInfo {
  mtimeMs: number;
  size: number;
}

export interface StatGatedIO<T> {
  /** {mtimeMs, size} for the file, or null when it is missing/unreadable. */
  stat(path: string): Promise<StatInfo | null>;
  /** Read + parse the file into the cached value, or null when unreadable. */
  load(path: string): Promise<T | null>;
}

interface Entry<T> {
  mtimeMs: number;
  size: number;
  value: T;
}

export interface StatGatedCache<T> {
  /** Return the cached value when the file is unchanged, else load + cache it.
   *  Returns null (and forgets any stale entry) when the file is gone/unreadable. */
  get(path: string, io: StatGatedIO<T>): Promise<T | null>;
  /** Clear everything (primarily for tests). */
  reset(): void;
  stats(): { size: number; hits: number; misses: number };
}

const DEFAULT_MAX = 512;

export function createStatGatedCache<T>(opts?: {
  max?: number;
}): StatGatedCache<T> {
  const max = Math.max(1, opts?.max ?? DEFAULT_MAX);
  // Map preserves insertion order → the first key is the least-recently-used.
  const map = new Map<string, Entry<T>>();
  // In-flight loads, so concurrent misses on the same path share ONE read+parse
  // instead of stampeding the file (the budget tick + the cost route can hit the
  // same session at once).
  const pending = new Map<string, Promise<T | null>>();
  let hits = 0;
  let misses = 0;

  function remember(path: string, st: StatInfo, value: T) {
    map.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
    // Evict least-recently-used entries beyond the bound.
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  return {
    async get(path, io) {
      const st = await io.stat(path);
      if (!st) {
        map.delete(path); // file gone → forget any stale entry
        return null;
      }
      const cached = map.get(path);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        hits++;
        // LRU touch: re-insert to move this key to the most-recent end.
        map.delete(path);
        map.set(path, cached);
        return cached.value;
      }
      // Coalesce a concurrent miss into the load already in flight for this path.
      const inflight = pending.get(path);
      if (inflight) return inflight;
      misses++;
      const load = (async () => {
        try {
          const value = await io.load(path);
          if (value == null) {
            map.delete(path);
            return null;
          }
          remember(path, st, value);
          return value;
        } catch {
          // Honor the load contract (null on failure) even if a caller's load
          // rejects, so a rejection can never propagate to concurrent joiners or up
          // into the cost computation. Best-effort: forget any stale entry.
          map.delete(path);
          return null;
        } finally {
          pending.delete(path);
        }
      })();
      pending.set(path, load);
      return load;
    },
    reset() {
      map.clear();
      pending.clear();
      hits = 0;
      misses = 0;
    },
    stats() {
      return { size: map.size, hits, misses };
    },
  };
}

/** Transcript cost caching is on by default; STOA_TRANSCRIPT_CACHE=0 disables it
 *  (e.g. an NFS / Tailscale home dir where mtime can't be trusted). */
export function transcriptCacheEnabled(): boolean {
  return process.env.STOA_TRANSCRIPT_CACHE !== "0";
}
