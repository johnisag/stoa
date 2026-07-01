/**
 * Project Playbooks + auto-recalled Knowledge (#13) — pure, client-safe core (no DB,
 * no fs, no server imports, so the NewSessionDialog + react-query hooks can import it).
 *
 * A playbook is a named prompt snippet with two uses from one row: SELECT it as a
 * RECIPE (its body seeds a new session's prompt), or set `pinned` on a project-scoped
 * one so its body is AUTO-prepended to every session in that project (curated
 * per-project KNOWLEDGE). A global (projectId null) playbook is a recipe available
 * everywhere and can't be pinned.
 */

export interface Playbook {
  id: string;
  name: string;
  body: string;
  /** null = a global recipe (every project); a project id = scoped to that project. */
  projectId: string | null;
  /** When true (and project-scoped), the body auto-prepends to that project's sessions. */
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The raw DB row (pinned as 0/1, snake_case). */
export interface PlaybookRow {
  id: string;
  name: string;
  body: string;
  project_id: string | null;
  pinned: number;
  created_at: string;
  updated_at: string;
}

export function rowToPlaybook(r: PlaybookRow): Playbook {
  return {
    id: r.id,
    name: r.name,
    body: r.body,
    projectId: r.project_id,
    pinned: r.pinned === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Bounds — a playbook is a short recipe / a curated fact block, not a document.
export const PLAYBOOK_NAME_MAX = 80;
export const PLAYBOOK_BODY_MAX = 4000;
/** Cap the number + total size of pinned snippets auto-injected per project, so a
 *  runaway pin set can't bloat (or poison the cache of) every launch prompt. */
export const MAX_PINNED_INJECTED = 10;

export type PlaybookInput = { name: string; body: string };

/**
 * Validate + normalize a create/update payload. Trims; requires a non-empty name and
 * body within bounds. Pure → unit-tested. (The API layer owns id/project/pinned.)
 */
export function validatePlaybookInput(
  raw: unknown
): { ok: true; value: PlaybookInput } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "expected an object" };
  }
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const body = typeof r.body === "string" ? r.body.trim() : "";
  if (!name) return { ok: false, reason: "name is required" };
  if (name.length > PLAYBOOK_NAME_MAX) {
    return { ok: false, reason: `name exceeds ${PLAYBOOK_NAME_MAX} chars` };
  }
  if (!body) return { ok: false, reason: "body is required" };
  if (body.length > PLAYBOOK_BODY_MAX) {
    return { ok: false, reason: `body exceeds ${PLAYBOOK_BODY_MAX} chars` };
  }
  return { ok: true, value: { name, body } };
}

/**
 * Render pinned playbooks as the auto-recall KNOWLEDGE block that leads a session's
 * prompt — a stable, per-project prefix (cache-friendly, like the lessons block).
 * Takes the FIRST MAX_PINNED_INJECTED in the caller's stable (oldest-first) order, so
 * the block stays byte-identical as newer pins are added (a 11th pin doesn't shift the
 * cached prefix — it's simply not injected). Empty in → "". Pure → unit-tested.
 */
export function buildKnowledgeBlock(
  pinned: Pick<Playbook, "name" | "body">[]
): string {
  const items = pinned
    .slice(0, MAX_PINNED_INJECTED)
    .map((p) => ({ name: p.name.trim(), body: p.body.trim() }))
    .filter((p) => p.body);
  if (items.length === 0) return "";
  const sections = items
    .map((p) => (p.name ? `## ${p.name}\n${p.body}` : p.body))
    .join("\n\n");
  return `PINNED PROJECT KNOWLEDGE (curated facts — keep these in mind):\n${sections}`;
}
