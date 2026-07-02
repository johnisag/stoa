/**
 * Saved workflows — service layer for the visual builder's persistence. Stores a
 * BuilderDoc (spec + canvas positions) as JSON, keyed by a generated id, so a
 * workflow becomes a named, reloadable artifact. Thin shell over the prepared
 * statements in lib/db/queries.ts; id/timestamps + JSON (de)serialization live here
 * (the DB layer stays pure SQL), mirroring lib/projects.ts.
 */

import { randomUUID } from "crypto";
import { db, queries, type SavedWorkflowRow } from "./db";
import {
  parseBuilderDoc,
  serializeBuilderDoc,
  type BuilderDoc,
  type HistorySnapshot,
  type SavedWorkflow,
} from "./pipeline/builder-model";

function parseHistory(raw: string): HistorySnapshot[] | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const parsed: HistorySnapshot[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const snapshot = item as Record<string, unknown>;
    if (
      typeof snapshot.id !== "string" ||
      typeof snapshot.name !== "string" ||
      typeof snapshot.createdAt !== "string"
    ) {
      continue;
    }
    const doc = parseBuilderDoc(
      typeof snapshot.doc === "string"
        ? snapshot.doc
        : JSON.stringify(snapshot.doc)
    );
    if (!doc) continue;
    parsed.push({
      id: snapshot.id,
      name: snapshot.name,
      doc,
      createdAt: snapshot.createdAt,
    });
  }
  return parsed;
}

function toSavedWorkflow(row: SavedWorkflowRow): SavedWorkflow {
  return {
    id: row.id,
    name: row.name,
    // A corrupt/legacy row must never crash a load — fall back to an empty doc
    // that still carries the row's name.
    doc: parseBuilderDoc(row.builder_doc) ?? {
      name: row.name,
      workingDirectory: "",
      nodes: [],
      notes: [],
    },
    history: parseHistory(row.history) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSavedWorkflow(input: {
  name: string;
  doc: BuilderDoc;
}): SavedWorkflow {
  // Trim so a padded/whitespace-only name can't be persisted (the API rejects an
  // empty-after-trim name first; this guards any direct caller too).
  const name = input.name.trim();
  if (!name) throw new Error("Workflow name is required");
  const id = randomUUID();
  queries
    .createSavedWorkflow(db)
    .run(id, name, serializeBuilderDoc(input.doc), "[]");
  const row = queries.getSavedWorkflow(db).get(id) as
    SavedWorkflowRow | undefined;
  // The row was just inserted in the same synchronous better-sqlite3 call, so a
  // miss is effectively unreachable — but guard the cast so a surprise surfaces a
  // clear error, not a confusing TypeError deref inside toSavedWorkflow.
  if (!row) {
    throw new Error(`Saved workflow ${id} not found immediately after insert`);
  }
  return toSavedWorkflow(row);
}

export function listSavedWorkflows(): SavedWorkflow[] {
  return (queries.getAllSavedWorkflows(db).all() as SavedWorkflowRow[]).map(
    toSavedWorkflow
  );
}

export function getSavedWorkflow(id: string): SavedWorkflow | undefined {
  const row = queries.getSavedWorkflow(db).get(id) as
    SavedWorkflowRow | undefined;
  return row ? toSavedWorkflow(row) : undefined;
}

export function updateSavedWorkflow(
  id: string,
  input: { name: string; doc: BuilderDoc }
): SavedWorkflow | undefined {
  const existing = getSavedWorkflow(id);
  if (!existing) return undefined;

  // Reject an empty-after-trim name (symmetric with createSavedWorkflow; the API
  // rejects first, this guards a direct caller).
  const trimmedName = input.name.trim();
  if (!trimmedName) throw new Error("Workflow name is required");

  // Snapshot the version we're about to overwrite. Label it with the shape it
  // captured (steps + notes) so the History menu lists distinguishable entries
  // instead of a column of identical "Save"s.
  const stepN = existing.doc.nodes.length;
  const noteN = existing.doc.notes.length;
  const name =
    `${stepN} step${stepN === 1 ? "" : "s"}` +
    (noteN > 0 ? `, ${noteN} note${noteN === 1 ? "" : "s"}` : "");
  const snapshot: HistorySnapshot = {
    id: randomUUID(),
    name,
    doc: existing.doc,
    createdAt: new Date().toISOString(),
  };
  const history = [snapshot, ...existing.history].slice(0, 10);

  queries
    .updateSavedWorkflow(db)
    .run(
      trimmedName,
      serializeBuilderDoc(input.doc),
      JSON.stringify(history),
      id
    );
  return getSavedWorkflow(id);
}

export function deleteSavedWorkflow(id: string): boolean {
  return queries.deleteSavedWorkflow(db).run(id).changes > 0;
}
