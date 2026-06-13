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
import { parsePipelineSpec } from "./engine";

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

/** A persisted builder doc with its store identity + timestamps (the API shape). */
export interface SavedWorkflow {
  id: string;
  name: string;
  doc: BuilderDoc;
  createdAt: string;
  updatedAt: string;
}

/** Serialize a doc for storage. */
export function serializeBuilderDoc(doc: BuilderDoc): string {
  return JSON.stringify(doc);
}

/**
 * Parse a stored doc defensively — a hand-edited or legacy row must never crash a
 * load. Returns null on anything that isn't a well-formed doc; drops malformed
 * nodes rather than failing the whole doc (mirrors the snippets-store shape guard).
 */
export function parseBuilderDoc(raw: string): BuilderDoc | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.workingDirectory !== "string") {
    return null;
  }
  if (!Array.isArray(o.nodes)) return null;
  const nodes: BuilderNode[] = [];
  for (const n of o.nodes) {
    if (!n || typeof n !== "object") continue;
    const node = n as Record<string, unknown>;
    const raw = node.step as Record<string, unknown> | undefined;
    if (
      !raw ||
      typeof raw.id !== "string" ||
      typeof raw.task !== "string" ||
      typeof raw.agent !== "string" ||
      typeof node.x !== "number" ||
      typeof node.y !== "number"
    ) {
      continue;
    }
    // Whitelist the known fields with per-field type checks rather than casting
    // the raw object through — this is a trust boundary (the API stores whatever
    // parses), so a malformed `dependsOn` (or any junk field) must NOT ride into a
    // stored doc and later throw in validateSpec or reach a spawn.
    const step: PipelineStep = {
      id: raw.id,
      agent: raw.agent as PipelineStep["agent"],
      task: raw.task,
    };
    if (typeof raw.name === "string") step.name = raw.name;
    if (typeof raw.model === "string") step.model = raw.model;
    if (
      Array.isArray(raw.dependsOn) &&
      raw.dependsOn.every((d) => typeof d === "string")
    ) {
      step.dependsOn = raw.dependsOn as string[];
    }
    if (typeof raw.workingDirectory === "string") {
      step.workingDirectory = raw.workingDirectory;
    }
    if (typeof raw.outputFile === "string") step.outputFile = raw.outputFile;
    if (typeof raw.exitCriteria === "string") {
      step.exitCriteria = raw.exitCriteria;
    }
    if (raw.worktreePolicy === "new" || raw.worktreePolicy === "shared") {
      step.worktreePolicy = raw.worktreePolicy;
    }
    nodes.push({ step, x: node.x, y: node.y });
  }
  return { name: o.name, workingDirectory: o.workingDirectory, nodes };
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

/** Re-snap every node to the clean topological layout (columns by dependency
 * depth, rows by spec order), preserving the steps + edges. Tidies a hand-arranged
 * canvas — re-seeding positions from layoutDag exactly as a fresh load would. */
export function relayout(doc: BuilderDoc): BuilderDoc {
  return docFromSpec(docToSpec(doc));
}

/**
 * Load an imported JSON string as a builder doc. Accepts EITHER a BuilderDoc
 * (canvas positions preserved) OR a bare PipelineSpec (positions seeded from the
 * layout) — so a workflow exported from the builder AND a spec authored in the
 * Custom tab both import. Null if the text is neither.
 */
export function docFromImportedJson(text: string): BuilderDoc | null {
  try {
    const doc = parseBuilderDoc(text);
    if (doc) return doc; // a BuilderDoc (has name + workingDirectory + nodes[])
    const { spec } = parsePipelineSpec(text); // else a bare PipelineSpec?
    return spec ? docFromSpec(spec) : null;
  } catch {
    return null; // never throw — a bad import file is a null, not a crash
  }
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

/**
 * Add a dependency edge `from → to` (i.e. `to` depends on `from`), as produced by
 * dragging a connector between two nodes on the canvas. A no-op for a self-edge,
 * an unknown target, or a duplicate. Permissive about cycles — validateSpec flags
 * a cycle so the UI shows it red, matching how the dependsOn checklist behaves.
 */
export function connect(doc: BuilderDoc, from: string, to: string): BuilderDoc {
  if (from === to) return doc;
  const target = doc.nodes.find((n) => n.step.id === to);
  if (!target) return doc;
  const deps = target.step.dependsOn ?? [];
  if (deps.includes(from)) return doc;
  return setDependsOn(doc, to, [...deps, from]);
}

/** Remove the dependency edge `from → to`. No-op if the target or edge is absent. */
export function disconnect(
  doc: BuilderDoc,
  from: string,
  to: string
): BuilderDoc {
  const target = doc.nodes.find((n) => n.step.id === to);
  const deps = target?.step.dependsOn ?? [];
  if (!deps.includes(from)) return doc;
  return setDependsOn(
    doc,
    to,
    deps.filter((d) => d !== from)
  );
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
