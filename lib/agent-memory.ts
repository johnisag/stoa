/**
 * Agent-accessible shared memory — the service layer for a fleet-wide key→value
 * scratchpad. Any agent reaches it through the orchestration MCP server's
 * `memory_*` tools (which call /api/memory) — and /api/memory is the SAME shared
 * surface a human UI would call (amux's "the human UI and the agents hit the exact
 * same endpoint" pattern, which is what makes a data store agent-usable rather
 * than human-only). A GUI panel over it is a follow-up; today the agents are the
 * consumers.
 *
 * The store is intentionally simple and GLOBAL (one shared namespace for the whole
 * fleet) so agents working in separate worktrees can coordinate: "the interface
 * contract is X", "don't touch file Y", a discovered gotcha. It is pull-based — an
 * agent reads a key on demand and the value lands in its context as data, never
 * auto-injected into a terminal — so, unlike inter-agent channels, there is no
 * keystroke-injection surface here.
 *
 * Thin shell over the prepared statements in lib/db/queries/; validation +
 * length caps live here (the DB layer stays pure SQL), mirroring lib/saved-workflows.ts.
 */

import { db, queries, type AgentMemoryRow } from "./db";

/** Max key length — a key is a short label, not a document. */
export const MEMORY_KEY_MAX_LENGTH = 256;
/** Max value length — same ceiling as a chat message; keeps one entry bounded. */
export const MEMORY_VALUE_MAX_LENGTH = 100_000;
/** Max rows returned by a list — bounds the response for a large scratchpad.
 * (There's no cap on the TOTAL number of keys: this is a single-user local tool,
 * so an agent bloating its own scratchpad is a self-inflicted non-issue.) */
export const MEMORY_LIST_LIMIT = 500;

/** A validation failure (the API route maps this to a 400). */
export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

/** Validate + normalize a key: a non-empty, trimmed label within the length cap.
 * Throws MemoryValidationError otherwise. Pure → unit-tested. */
export function normalizeMemoryKey(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new MemoryValidationError("key is required");
  }
  const key = raw.trim();
  if (!key) throw new MemoryValidationError("key is required");
  if (key.length > MEMORY_KEY_MAX_LENGTH) {
    throw new MemoryValidationError(
      `key exceeds ${MEMORY_KEY_MAX_LENGTH} characters`
    );
  }
  return key;
}

/** Validate a value: a string within the length cap (an empty string is allowed —
 * a deliberately-blank note). Throws MemoryValidationError otherwise. Pure. */
export function validateMemoryValue(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new MemoryValidationError("value must be a string");
  }
  if (raw.length > MEMORY_VALUE_MAX_LENGTH) {
    throw new MemoryValidationError(
      `value exceeds ${MEMORY_VALUE_MAX_LENGTH} characters`
    );
  }
  return raw;
}

/** Upsert a memory entry (create or overwrite by key). Validates first; returns
 * the stored row. */
export function setMemory(key: unknown, value: unknown): AgentMemoryRow {
  const k = normalizeMemoryKey(key);
  const v = validateMemoryValue(value);
  queries.upsertAgentMemory(db).run(k, v);
  return queries.getAgentMemory(db).get(k) as AgentMemoryRow;
}

/** Read one memory entry by key, or null when it isn't set. Validates the key. */
export function getMemory(key: unknown): AgentMemoryRow | null {
  const k = normalizeMemoryKey(key);
  return (
    (queries.getAgentMemory(db).get(k) as AgentMemoryRow | undefined) ?? null
  );
}

/** List memory entries, most-recently-updated first (bounded). */
export function listMemory(): AgentMemoryRow[] {
  return queries.listAgentMemory(db).all(MEMORY_LIST_LIMIT) as AgentMemoryRow[];
}

/** Delete a memory entry by key. Returns true when a row was removed. Validates
 * the key. */
export function deleteMemory(key: unknown): boolean {
  const k = normalizeMemoryKey(key);
  return queries.deleteAgentMemory(db).run(k).changes > 0;
}
