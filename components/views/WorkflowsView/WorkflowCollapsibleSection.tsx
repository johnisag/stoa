"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A titled, collapsible panel used by the workflow builder's stacked sections
 * (Design with AI, Settings, Agents). Extracted verbatim from WorkflowBuilder so
 * the sibling panels can share it; behavior is byte-identical.
 */
export function CollapsibleSection({
  title,
  icon: Icon,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex-shrink-0 rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium"
      >
        <div className="flex items-center gap-1.5">
          {Icon && <Icon className="text-muted-foreground h-4 w-4" />}
          <span>{title}</span>
        </div>
        <ChevronDown
          className={cn(
            "text-muted-foreground h-4 w-4 transition-transform",
            open && "rotate-180"
          )}
        />
      </button>
      {open && <div className="px-3 pt-1 pb-3">{children}</div>}
    </div>
  );
}
