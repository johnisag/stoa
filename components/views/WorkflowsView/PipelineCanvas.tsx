"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { CANVAS, type BuilderDoc } from "@/lib/pipeline/builder-model";
import { cn } from "@/lib/utils";

const { NODE_W, NODE_H, PAD } = CANVAS;

/**
 * Interactive workflow canvas — draggable SVG nodes over a dependency-free render
 * (the same 1-unit-per-px viewBox model as PipelineGraph, so client→SVG mapping is
 * a plain getBoundingClientRect subtraction with no CTM math). Nodes are moved with
 * Pointer Events + setPointerCapture, a single code path for mouse, touch, and pen.
 * `touch-action: none` lives ONLY on the node <g>: a finger-drag on a node moves the
 * box, while a finger-drag on empty canvas falls through to native scroll (the svg
 * must NOT carry touch-none or it would trap the page scroll on a phone). Controlled:
 * the parent owns the doc and applies onMoveNode/onSelectNode.
 */
export function PipelineCanvas({
  doc,
  selectedId,
  onSelectNode,
  onMoveNode,
}: {
  doc: BuilderDoc;
  selectedId: string | null;
  onSelectNode: (id: string | null) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Active drag: which node, and the grab offset (pointer − node origin) so the
  // node doesn't jump its top-left to the cursor on grab. A ref, not state, so a
  // drag in flight doesn't re-render on every pointermove (only onMoveNode does).
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  // Pointer client coords → SVG user space. viewBox == width/height (1:1, no
  // transform), so subtracting the svg's rect is exact even while scrolled.
  function toUser(e: ReactPointerEvent) {
    const r = svgRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  }

  function onNodePointerDown(e: ReactPointerEvent, id: string) {
    e.stopPropagation();
    onSelectNode(id);
    const node = doc.nodes.find((n) => n.step.id === id);
    if (!node) return;
    const p = toUser(e);
    drag.current = { id, dx: p.x - node.x, dy: p.y - node.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onNodePointerMove(e: ReactPointerEvent) {
    if (!drag.current) return;
    const p = toUser(e);
    onMoveNode(drag.current.id, p.x - drag.current.dx, p.y - drag.current.dy);
  }

  function onNodePointerUp(e: ReactPointerEvent) {
    if (drag.current && e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    drag.current = null;
  }

  const byId = new Map(doc.nodes.map((n) => [n.step.id, n]));
  const width =
    PAD + Math.max(NODE_W, ...doc.nodes.map((n) => n.x + NODE_W)) + PAD;
  const height =
    PAD + Math.max(NODE_H, ...doc.nodes.map((n) => n.y + NODE_H)) + PAD;

  return (
    <div className="bg-muted/20 max-h-[40vh] overflow-auto rounded-md border">
      <svg
        ref={svgRef}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="text-foreground"
        // Pointer-down on the empty canvas (not a node) clears the selection.
        onPointerDown={() => onSelectNode(null)}
      >
        <defs>
          <marker
            id="stoa-canvas-arrow"
            viewBox="0 0 8 8"
            refX={7}
            refY={4}
            markerWidth={6}
            markerHeight={6}
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 7 4 L 0 7 z" className="fill-border" />
          </marker>
        </defs>

        {/* Edges from each step to the steps that depend on it. Free node
            positions, so a horizontal-tangent Bézier between node mid-heights. */}
        {doc.nodes.flatMap((n) =>
          (n.step.dependsOn ?? []).map((depId) => {
            const a = byId.get(depId);
            const b = n;
            if (!a) return null;
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x - 4;
            const y2 = b.y + NODE_H / 2;
            const c = Math.max(40, Math.abs(x2 - x1) / 2);
            return (
              <path
                key={`${depId}->${n.step.id}`}
                d={`M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`}
                fill="none"
                className="stroke-border"
                strokeWidth={1.5}
                markerEnd="url(#stoa-canvas-arrow)"
              />
            );
          })
        )}

        {doc.nodes.map((n) => {
          const selected = n.step.id === selectedId;
          const label = n.step.name || n.step.id;
          return (
            <g
              key={n.step.id}
              transform={`translate(${n.x}, ${n.y})`}
              className="cursor-grab touch-none active:cursor-grabbing"
              onPointerDown={(e) => onNodePointerDown(e, n.step.id)}
              onPointerMove={onNodePointerMove}
              onPointerUp={onNodePointerUp}
              onPointerCancel={onNodePointerUp}
            >
              {/* Full label as a native tooltip / accessible name — node text is
                  truncated, so two long shared-prefix names stay distinguishable. */}
              <title>{label}</title>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={8}
                strokeWidth={selected ? 2 : 1}
                className={cn(
                  "fill-card",
                  selected ? "stroke-primary" : "stroke-border"
                )}
              />
              <text
                x={10}
                y={18}
                fill="currentColor"
                fontSize={12}
                fontWeight={500}
              >
                {label.length > 18 ? `${label.slice(0, 17)}…` : label}
              </text>
              <text
                x={10}
                y={34}
                className="fill-muted-foreground"
                fontSize={10}
              >
                {n.step.agent}
                {n.step.task?.trim() ? "" : " · no task yet"}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
