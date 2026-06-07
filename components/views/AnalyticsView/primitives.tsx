"use client";

/**
 * Small presentational primitives for the Analytics view — stat cards, bar rows,
 * and an inline SVG sparkline. Deliberately dependency-free (no charting lib):
 * the cockpit ships native on three OSes and we keep the bundle lean, so charts
 * are hand-rolled SVG/CSS that theme with the rest of the UI.
 */

import { cn } from "@/lib/utils";

/** A labelled metric tile. `hint` renders small + muted under the value. */
export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-400"
      : tone === "warn"
        ? "text-yellow-400"
        : tone === "bad"
          ? "text-red-400"
          : "text-foreground";
  return (
    <div className="bg-card flex flex-col gap-1 rounded-lg border p-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={cn("text-xl font-semibold tabular-nums", toneClass)}>
        {value}
      </span>
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </div>
  );
}

/** A horizontal proportion bar with a label and count (the behaviour mix). */
export function BarRow({
  label,
  value,
  max,
  suffix,
}: {
  label: string;
  value: number;
  max: number;
  suffix?: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3 text-sm">
      <span
        className="text-muted-foreground w-32 shrink-0 truncate"
        title={label}
      >
        {label}
      </span>
      <div className="bg-muted h-2.5 flex-1 overflow-hidden rounded-full">
        <div
          className="bg-primary h-full rounded-full"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-16 shrink-0 text-right tabular-nums">
        {value.toLocaleString()}
        {suffix}
      </span>
    </div>
  );
}

/**
 * An inline SVG sparkline over a numeric series. Renders a baseline + the path;
 * a flat/empty series degrades to a centered flat line. ViewBox-scaled so it
 * fills its container responsively (mobile-first).
 */
export function Sparkline({
  values,
  className,
  height = 40,
  label,
}: {
  values: number[];
  className?: string;
  height?: number;
  /** Accessible description of the series (screen readers can't see the SVG). */
  label?: string;
}) {
  const W = 100;
  const H = height;
  const pad = 2;
  const a11y =
    label ??
    (values.length
      ? `Trend, ${values.length} points, latest ${values[values.length - 1]}`
      : "No data");
  if (values.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className={cn("w-full", className)}
        style={{ height }}
        role="img"
        aria-label={a11y}
      />
    );
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const n = values.length;
  const x = (i: number) =>
    n === 1 ? W / 2 : (i / (n - 1)) * (W - pad * 2) + pad;
  const y = (v: number) => H - pad - ((v - min) / span) * (H - pad * 2);
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${pad},${H - pad} ${points} ${W - pad},${H - pad}`;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("w-full", className)}
      style={{ height }}
      role="img"
      aria-label={a11y}
    >
      <polygon points={area} className="fill-primary/10" />
      <polyline
        points={points}
        fill="none"
        className="stroke-primary"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* A single data point has no line segment — draw a dot so it's visible. */}
      {n === 1 && (
        <circle cx={x(0)} cy={y(values[0])} r={2} className="fill-primary" />
      )}
    </svg>
  );
}

/** Format a possibly-null number as a fixed string, or an em-dash when null. */
export function fmt(
  n: number | null | undefined,
  opts: { prefix?: string; suffix?: string; dp?: number } = {}
): string {
  if (n == null) return "—";
  const { prefix = "", suffix = "", dp } = opts;
  const body = dp != null ? n.toFixed(dp) : n.toLocaleString(undefined, {});
  return `${prefix}${body}${suffix}`;
}

/** Compact seconds → "1.2m" / "3.4h" / "45s" for durations. */
export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}
