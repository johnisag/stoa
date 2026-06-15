"use client";

import { useId } from "react";
import { layoutDag } from "@/lib/pipeline/graph-layout";
import type { PipelineSpec, StepStatus } from "@/lib/pipeline/types";
import { cn } from "@/lib/utils";
import { STEP_STATUS_META } from "./shared";

const NODE_W = 132;
const NODE_H = 34;
const COL_W = 180; // column pitch (node + horizontal gap)
const ROW_H = 54; // row pitch (node + vertical gap)
const PAD = 8;

/**
 * Read-only DAG view of a pipeline — dependency-free inline SVG (the same
 * no-library idiom as the analytics charts). Columns = longest-path depth, rows =
 * spec order; each node is colored by its live step status (the shared
 * STEP_STATUS_META palette — same source as the list rows) when `statusById` is
 * given (the Runs board) or neutral when it isn't (the Custom editor preview).
 * Edges carry an arrowhead so the dependency direction reads even when the graph
 * is wider than the viewport; horizontally scrollable on a phone.
 */
export function PipelineGraph({
  spec,
  statusById,
}: {
  spec: PipelineSpec;
  statusById?: Record<string, StepStatus | undefined>;
}) {
  // Per-instance arrowhead id — two PipelineGraphs mounted at once (e.g. a Custom
  // preview + a RunDetail graph) must not share a marker id (every markerEnd would
  // resolve to the first one in document order).
  const arrowId = `stoa-graph-arrow-${useId()}`;
  const layout = layoutDag(spec);
  if (layout.nodes.length === 0) return null;

  const pos = new Map(layout.nodes.map((n) => [n.id, n]));
  const x = (level: number) => PAD + level * COL_W;
  const y = (row: number) => PAD + row * ROW_H;
  const width = PAD * 2 + (layout.levelCount - 1) * COL_W + NODE_W;
  const height = PAD * 2 + (layout.rowCount - 1) * ROW_H + NODE_H;

  return (
    <div className="overflow-x-auto">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Workflow graph: ${layout.nodes.length} steps`}
        className="text-foreground"
      >
        <defs>
          {/* Arrowhead on the target end of each edge so flow direction reads. */}
          <marker
            id={arrowId}
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

        {/* Edges first (under the nodes). A smooth left→right S-curve from the
            right edge of the source to the left edge of the target. The path
            stops a few px short of the node so the arrowhead sits in the gap. */}
        {layout.edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const x1 = x(a.level) + NODE_W;
          const y1 = y(a.row) + NODE_H / 2;
          const x2 = x(b.level) - 4;
          const y2 = y(b.row) + NODE_H / 2;
          const mx = (x1 + x2) / 2;
          return (
            <path
              key={i}
              d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
              fill="none"
              className="stroke-border"
              strokeWidth={1.5}
              markerEnd={`url(#${arrowId})`}
            />
          );
        })}

        {layout.nodes.map((n) => {
          const status = statusById?.[n.id] ?? "pending";
          const nx = x(n.level);
          const ny = y(n.row);
          return (
            <g key={n.id}>
              <rect
                x={nx}
                y={ny}
                width={NODE_W}
                height={NODE_H}
                rx={6}
                className="fill-card stroke-border"
                strokeWidth={1}
              />
              <circle
                cx={nx + 12}
                cy={ny + NODE_H / 2}
                r={4}
                className={cn(STEP_STATUS_META[status].swatch)}
              />
              <text
                x={nx + 24}
                y={ny + NODE_H / 2}
                dominantBaseline="central"
                fill="currentColor"
                fontSize={11}
              >
                {n.label.length > 16 ? `${n.label.slice(0, 15)}…` : n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
