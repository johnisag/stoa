"use client";

import { useRef, type ReactNode, type KeyboardEvent } from "react";
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
 *
 * `panelId` optionally links the tab to its corresponding tabpanel via
 * `aria-controls`.
 */
export type SegmentedTab<T extends string> = {
  key: T;
  label: ReactNode;
  badge?: ReactNode | { count: number; className?: string };
  panelId?: string;
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
 * touch target. Implements roving tabindex and arrow/Home/End keyboard navigation
 * so the tab strip behaves like a real tab list.
 *
 * Use `className` to extend the wrapper (e.g. horizontal scroll for a long strip)
 * and `tabClassName` to extend each button (e.g. `capitalize text-xs`).
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
  const activeIndex = tabs.findIndex((t) => t.key === value);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const moveFocus = (nextIndex: number) => {
    const tab = tabs[nextIndex];
    if (!tab) return;
    onChange(tab.key);
    // Move DOM focus to the newly activated tab so the roving-tabindex pattern
    // is complete: focus follows selection.
    buttonRefs.current[nextIndex]?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || tabs.length === 0) return;

    switch (e.key) {
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        moveFocus(activeIndex <= 0 ? tabs.length - 1 : activeIndex - 1);
        break;
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        moveFocus(activeIndex >= tabs.length - 1 ? 0 : activeIndex + 1);
        break;
      case "Home":
        e.preventDefault();
        moveFocus(0);
        break;
      case "End":
        e.preventDefault();
        moveFocus(tabs.length - 1);
        break;
    }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={cn("bg-muted inline-flex rounded-md p-0.5 text-sm", className)}
    >
      {tabs.map((t, i) => {
        const active = value === t.key;
        return (
          <button
            ref={(el) => {
              buttonRefs.current[i] = el;
            }}
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={t.panelId}
            tabIndex={active ? 0 : -1}
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
