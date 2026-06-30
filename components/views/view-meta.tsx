import {
  Workflow,
  Columns3,
  BarChart3,
  Rocket,
  Inbox,
  Sparkles,
  Layers,
  Gauge,
} from "lucide-react";
import type { ComponentType } from "react";
import type { ViewKind } from "@/lib/panes";

/**
 * Display metadata (tab-strip label + icon) for each non-terminal fleet VIEW that
 * opens as a pane tab. The RENDER wiring lives in components/Pane (which has the
 * handler closures); this is the shared display half, used by the tab bars so the
 * label/icon for a view live in ONE place — add a view here when it's converted.
 */
export interface ViewMeta {
  label: string;
  Icon: ComponentType<{ className?: string }>;
}

export const VIEW_META: Partial<Record<ViewKind, ViewMeta>> = {
  workflows: { label: "Workflows", Icon: Workflow },
  "fleet-board": { label: "Fleet Board", Icon: Columns3 },
  analytics: { label: "Insight", Icon: BarChart3 },
  dispatch: { label: "Dispatch", Icon: Rocket },
  "verdict-inbox": { label: "Verdict Inbox", Icon: Inbox },
  ask: { label: "Ask Stoa", Icon: Sparkles },
  "best-of-n": { label: "Best of N", Icon: Layers },
  "agent-monitor": { label: "Agent Monitor", Icon: Gauge },
};

/** The display metadata for a tab's view, or undefined for a terminal/unknown one. */
export function viewMeta(view: ViewKind | undefined): ViewMeta | undefined {
  return view ? VIEW_META[view] : undefined;
}

/** The tab-strip icon for a view (null for a terminal/unknown one). */
export function ViewTabIcon({
  view,
  className,
}: {
  view: ViewKind | undefined;
  className?: string;
}) {
  const meta = viewMeta(view);
  if (!meta) return null;
  const Icon = meta.Icon;
  return <Icon className={className} />;
}
