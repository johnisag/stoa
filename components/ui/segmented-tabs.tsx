"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A single segment in a {@link SegmentedTabs} strip.
 *
 * `badge` is optional and accepts either:
 *  - a ready-made `ReactNode` (rendered as-is), or
 *  - a `{ count, className? }` count pill — rendered only when `count > 0`, with
 *    the shared pill shape (`rounded-full px-1.5 text-xs`) and `className` for the
 *    colour (defaults to `bg-foreground/10`; pass e.g. a red/yellow tone for a
 *    severity-coded count).
 */
export type SegmentedTab<T extends string> = {
  key: T;
  label: ReactNode;
  badge?: ReactNode | { count: number; className?: string };
};

function isCountBadge(
  badge: SegmentedTab<string>["badge"]
): badge is { count: number; className?: string } {
  return (
    typeof badge === "object" &&
    badge !== null &&
    "count" in badge &&
    typeof (badge as { count: unknown }).count === "number"
  );
}

/**
 * Shared segmented-control tab strip — the `bg-muted` pill-of-buttons used across
 * the fleet dialogs (Dispatch, Verdict Inbox, Workflows, Insight) and the Dispatch
 * allocation console. Generic over the tab key type.
 *
 * Carries the Insight view's a11y/touch baseline for every caller: `role="tablist"`
 * on the wrapper, `role="tab"` + `aria-selected` per button, and a `min-h-[40px]`
 * touch target. Use `className` to extend the wrapper (e.g. horizontal scroll for a
 * long strip) and `tabClassName` to extend each button (e.g. `capitalize text-xs`).
 *
 * `onChange` fires on every click (including a click on the already-active tab) —
 * callers that must avoid redundant work on a same-value click should guard at the
 * call site.
 */
export function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  disabled,
  className,
  tabClassName,
}: {
  tabs: readonly SegmentedTab<T>[];
  value: T;
  onChange: (key: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Extra classes for the wrapper (e.g. overflow-x-auto for a long strip). */
  className?: string;
  /** Extra classes for every tab button (e.g. `capitalize text-xs`). */
  tabClassName?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("bg-muted inline-flex rounded-md p-0.5 text-sm", className)}
    >
      {tabs.map((t) => {
        const active = value === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onChange(t.key)}
            className={cn(
              "inline-flex min-h-[40px] items-center gap-1.5 rounded px-3 py-1.5 whitespace-nowrap transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              disabled && "cursor-not-allowed opacity-50",
              tabClassName
            )}
          >
            {t.label}
            {isCountBadge(t.badge)
              ? t.badge.count > 0 && (
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-xs",
                      t.badge.className ?? "bg-foreground/10"
                    )}
                  >
                    {t.badge.count}
                  </span>
                )
              : t.badge}
          </button>
        );
      })}
    </div>
  );
}
