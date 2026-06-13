/**
 * Pipeline DAG layout — PURE. Turns a PipelineSpec into a layered node/edge graph
 * for a dependency-free SVG render (mirrors the analytics charts' no-dependency
 * idiom — no graph library). Columns = longest-path depth from a root; rows =
 * stable spec order within a column. So a fan-out spreads down a column and a
 * fan-in pulls back to the next. No I/O — exhaustively unit-testable.
 */

import type { PipelineSpec } from "./types";

export interface GraphNode {
  id: string;
  /** Display label (step.name ?? id). */
  label: string;
  /** Column index = longest dependency path from a root (roots = 0). */
  level: number;
  /** Row index within the column (0-based, in spec order). */
  row: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Number of columns (levels). */
  levelCount: number;
  /** Tallest column's row count. */
  rowCount: number;
}

/**
 * Lay out a pipeline DAG into columns (longest-path depth) and rows. Assumes a
 * valid DAG (validateSpec rejects cycles), but a `computing` guard keeps it
 * terminating even on a malformed cyclic input (a cycle node falls back to level
 * 0). Unknown deps are ignored (validateSpec would already have flagged them).
 */
export function layoutDag(spec: PipelineSpec): GraphLayout {
  const steps = spec?.steps ?? [];
  const byId = new Map(steps.map((s) => [s.id, s]));
  const levelCache = new Map<string, number>();
  const computing = new Set<string>();

  const level = (id: string): number => {
    const cached = levelCache.get(id);
    if (cached != null) return cached;
    if (computing.has(id)) return 0; // cycle guard (shouldn't happen post-validate)
    computing.add(id);
    const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d));
    const lvl =
      deps.length === 0 ? 0 : Math.max(...deps.map((d) => level(d) + 1));
    computing.delete(id);
    levelCache.set(id, lvl);
    return lvl;
  };

  const nextRow = new Map<number, number>();
  const nodes: GraphNode[] = [];
  for (const s of steps) {
    const lvl = level(s.id);
    const row = nextRow.get(lvl) ?? 0;
    nextRow.set(lvl, row + 1);
    // Coerce to string — validateSpec doesn't type-check `name`, so a hand-authored
    // spec with a non-string name (e.g. `"name": 123`) must not reach the SVG render
    // and throw on `.length`/`.slice`. label is always a string by construction.
    nodes.push({ id: s.id, label: String(s.name || s.id), level: lvl, row });
  }

  const edges: GraphEdge[] = [];
  for (const s of steps) {
    for (const d of s.dependsOn ?? []) {
      if (byId.has(d)) edges.push({ from: d, to: s.id });
    }
  }

  return {
    nodes,
    edges,
    levelCount: nodes.reduce((m, n) => Math.max(m, n.level + 1), 0),
    rowCount: [...nextRow.values()].reduce((m, c) => Math.max(m, c), 0),
  };
}
