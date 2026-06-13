"use client";

import { useEffect, useState } from "react";
import { Square, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  cardActionsForStatus,
  type RespondAction,
} from "@/lib/notification-actions";
import type { SessionStatus } from "@/lib/status-detector";
import { useRespondToSession } from "@/data/sessions/queries";

const META: Record<
  RespondAction,
  { icon: LucideIcon; label: string; className: string }
> = {
  stop: {
    icon: Square,
    label: "Stop",
    className: "text-red-600 hover:bg-red-500/10 dark:text-red-400",
  },
};

/**
 * Per-card quick action — one-tap Stop a live session straight from the board, the
 * in-app twin of the lock-screen notification's Stop button (same /respond
 * endpoint). Self-contained (reads its own mutation hook) so it doesn't thread a
 * callback through every list view and preserves the SessionCard memo. Renders
 * nothing for statuses with no actionable choice (idle/dead). (Attention-only: no
 * approve/reject — you swap to the session and type; the notification already told
 * you it's ready / needs input.)
 */
export function SessionQuickActions({
  sessionId,
  status,
  hasPrompt,
  name,
}: {
  sessionId: string;
  status: SessionStatus;
  hasPrompt?: boolean;
  name: string;
}) {
  const respond = useRespondToSession();
  // Optimistic dismiss: hide the buttons the instant one is tapped (don't wait
  // for a status change that may never come — e.g. a conductor that's "waiting"
  // for your next message, not at a prompt). Reset when the status changes, so a
  // genuinely new actionable state surfaces fresh buttons.
  const [acted, setActed] = useState(false);
  // Re-arm the buttons when the actionable state changes — a new status OR a prompt
  // appearing/clearing (a prompt can arrive while status stays "waiting"). (A direct
  // prompt→prompt swap with no gap doesn't re-arm here — threading the prompt line
  // would; tracked as a follow-up — but the buttons return on the next status tick.)
  useEffect(() => setActed(false), [status, hasPrompt]);

  const actions = cardActionsForStatus(status);
  if (actions.length === 0 || acted) return null;

  return (
    <div
      className="flex flex-shrink-0 items-center gap-0.5"
      // Stop both click (card select/open) and pointerdown (the card's
      // ContextMenuTrigger long-press on touch) from bubbling to the row.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {actions.map((action) => {
        const { icon: Icon, label, className } = META[action];
        return (
          <button
            key={action}
            type="button"
            disabled={respond.isPending}
            aria-label={`${label} ${name}`}
            className={cn(
              "flex min-h-[32px] flex-shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors outline-none disabled:opacity-50",
              className
            )}
            onClick={(e) => {
              e.stopPropagation();
              setActed(true); // vanish immediately on tap
              respond.mutate(
                { sessionId, action },
                {
                  onError: (err) =>
                    toast.error(`Couldn't ${action} ${name}: ${err.message}`),
                }
              );
            }}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
