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
  type SavedWorkflow,
} from "./pipeline/builder-model";

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
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSavedWorkflow(input: {
  name: string;
  doc: BuilderDoc;
}): SavedWorkflow {
  const id = randomUUID();
  queries
    .createSavedWorkflow(db)
    .run(id, input.name, serializeBuilderDoc(input.doc));
  return toSavedWorkflow(
    queries.getSavedWorkflow(db).get(id) as SavedWorkflowRow
  );
}

export function listSavedWorkflows(): SavedWorkflow[] {
  return (queries.getAllSavedWorkflows(db).all() as SavedWorkflowRow[]).map(
    toSavedWorkflow
  );
}

export function getSavedWorkflow(id: string): SavedWorkflow | undefined {
  const row = queries.getSavedWorkflow(db).get(id) as
    | SavedWorkflowRow
    | undefined;
  return row ? toSavedWorkflow(row) : undefined;
}

export function updateSavedWorkflow(
  id: string,
  input: { name: string; doc: BuilderDoc }
): SavedWorkflow | undefined {
  const result = queries
    .updateSavedWorkflow(db)
    .run(input.name, serializeBuilderDoc(input.doc), id);
  if (result.changes === 0) return undefined;
  return getSavedWorkflow(id);
}

export function deleteSavedWorkflow(id: string): boolean {
  return queries.deleteSavedWorkflow(db).run(id).changes > 0;
}
