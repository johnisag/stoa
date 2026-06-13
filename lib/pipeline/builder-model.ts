/**
 * Visual workflow builder — PURE document model. A BuilderDoc is a PipelineSpec
 * plus a canvas position (x/y) per step, so the visual canvas can place and drag
 * nodes while staying a faithful view of an executable spec. Every operation
 * returns a NEW doc (immutable) and is I/O-free, so the whole builder is driven
 * by exhaustively unit-testable transitions — the same pure-core / thin-shell
 * split as the pipeline engine.
 *
 * Positions are seeded from the read-only layout (layoutDag) and then overridable
 * by dragging; they are NOT part of the spec (PipelineSpec has no coordinates), so
 * a round-trip through JSON re-seeds them from the topology. That's intentional —
 * the executable contract stays clean; the layout is a builder-only affordance.
 */

import type { PipelineSpec, PipelineStep } from "./types";
import type { AgentType } from "../providers";
import { layoutDag } from "./graph-layout";

/** Canvas geometry (1 SVG user-unit = 1 px, matching PipelineGraph). Roomier than
 * the read-only graph — these nodes are tap/drag targets, so mobile-first sizing. */
export const CANVAS = {
  NODE_W: 160,
  NODE_H: 48,
  COL_W: 210, // column pitch when seeding from layout depth
  ROW_H: 96, // row pitch
  PAD: 16,
} as const;

export interface BuilderNode {
  step: PipelineStep;
  x: number;
  y: number;
}

export interface BuilderDoc {
  name: string;
  workingDirectory: string;
  nodes: BuilderNode[];
}

/** Seed a builder doc from a spec, placing each node by its layout depth/row. */
export function docFromSpec(spec: PipelineSpec): BuilderDoc {
  const layout = layoutDag(spec);
  const placed = new Map(layout.nodes.map((n) => [n.id, n]));
  return {
    name: spec.name ?? "",
    workingDirectory: spec.workingDirectory ?? "",
    nodes: (spec.steps ?? []).map((step) => {
      const p = placed.get(step.id);
      return {
        step,
        x: CANVAS.PAD + (p?.level ?? 0) * CANVAS.COL_W,
        y: CANVAS.PAD + (p?.row ?? 0) * CANVAS.ROW_H,
      };
    }),
  };
}

/** Project a builder doc back to an executable spec (drops positions). Order is
 * preserved so the resulting JSON reads in the same order the nodes were added. */
export function docToSpec(doc: BuilderDoc): PipelineSpec {
  return {
    name: doc.name,
    workingDirectory: doc.workingDirectory,
    steps: doc.nodes.map((n) => n.step),
  };
}

/** A fresh step id not already used in the doc: `base`, then `base-2`, `base-3`… */
export function uniqueStepId(doc: BuilderDoc, base = "step"): string {
  const used = new Set(doc.nodes.map((n) => n.step.id));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Append a new step at (x, y) with a unique id and the default agent. */
export function addStep(
  doc: BuilderDoc,
  x: number,
  y: number,
  agent: AgentType = "claude"
): BuilderDoc {
  const id = uniqueStepId(doc);
  return {
    ...doc,
    nodes: [...doc.nodes, { step: { id, agent, task: "" }, x, y }],
  };
}

/** Move a node to (x, y), clamped to the top-left padding so it can't drift
 * off-canvas into negative space. */
export function moveNode(
  doc: BuilderDoc,
  id: string,
  x: number,
  y: number
): BuilderDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.step.id === id
        ? { ...n, x: Math.max(0, x), y: Math.max(0, y) }
        : n
    ),
  };
}

/** Merge a patch into a step's fields (not its id — use renameStep for that). */
export function updateStep(
  doc: BuilderDoc,
  id: string,
  patch: Partial<Omit<PipelineStep, "id">>
): BuilderDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.step.id === id ? { ...n, step: { ...n.step, ...patch } } : n
    ),
  };
}

/** Replace a step's dependency set (deduped, self-dep dropped). */
export function setDependsOn(
  doc: BuilderDoc,
  id: string,
  deps: string[]
): BuilderDoc {
  const clean = [...new Set(deps)].filter((d) => d !== id);
  return updateStep(doc, id, {
    dependsOn: clean.length ? clean : undefined,
  });
}

/** Remove a step and strip its id from every other step's dependsOn. */
export function removeStep(doc: BuilderDoc, id: string): BuilderDoc {
  return {
    ...doc,
    nodes: doc.nodes
      .filter((n) => n.step.id !== id)
      .map((n) => {
        if (!n.step.dependsOn?.includes(id)) return n;
        const dependsOn = n.step.dependsOn.filter((d) => d !== id);
        return {
          ...n,
          step: { ...n.step, dependsOn: dependsOn.length ? dependsOn : undefined },
        };
      }),
  };
}

/**
 * Rename a step's id, cascading the change into every other step's dependsOn.
 * A no-op if the new id is empty, unchanged, or already taken (the caller's form
 * surfaces the conflict) — so the doc never ends up with duplicate or dangling ids.
 */
export function renameStep(
  doc: BuilderDoc,
  oldId: string,
  newId: string
): BuilderDoc {
  if (!newId || newId === oldId) return doc;
  if (doc.nodes.some((n) => n.step.id === newId)) return doc;
  return {
    ...doc,
    nodes: doc.nodes.map((n) => ({
      ...n,
      step: {
        ...n.step,
        id: n.step.id === oldId ? newId : n.step.id,
        dependsOn: n.step.dependsOn?.map((d) => (d === oldId ? newId : d)),
      },
    })),
  };
}
