"use client";

import { CheckCircle2, XCircle, Square, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import {
  AIconButton,
  type AIconButtonHighlight,
} from "@/components/a/AIconButton";
import {
  cardActionsForStatus,
  type RespondAction,
} from "@/lib/notification-actions";
import type { SessionStatus } from "@/lib/status-detector";
import { useRespondToSession } from "@/data/sessions/queries";

const META: Record<
  RespondAction,
  { icon: LucideIcon; label: string; highlight: AIconButtonHighlight }
> = {
  approve: { icon: CheckCircle2, label: "Approve", highlight: "green" },
  reject: { icon: XCircle, label: "Reject", highlight: "orange" },
  stop: { icon: Square, label: "Stop", highlight: "red" },
};

/**
 * Per-card quick actions — approve/reject/stop a session straight from the board,
 * the in-app twin of the lock-screen notification buttons (same /respond
 * endpoint). Self-contained (reads its own mutation hook) so it doesn't thread a
 * callback through every list view and preserves the SessionCard memo. Renders
 * nothing for statuses with no actionable choice (idle/dead).
 */
export function SessionQuickActions({
  sessionId,
  status,
  name,
}: {
  sessionId: string;
  status: SessionStatus;
  name: string;
}) {
  const respond = useRespondToSession();
  const actions = cardActionsForStatus(status);
  if (actions.length === 0) return null;

  return (
    <div
      className="flex flex-shrink-0 items-center gap-0.5"
      // Stop both click (card select/open) and pointerdown (the card's
      // ContextMenuTrigger long-press on touch) from bubbling to the row.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {actions.map((action) => {
        const { icon, label, highlight } = META[action];
        return (
          <AIconButton
            key={action}
            icon={icon}
            size="sm"
            tooltip={label}
            highlight={highlight}
            disabled={respond.isPending}
            aria-label={`${label} ${name}`}
            onClick={(e) => {
              e.stopPropagation();
              respond.mutate(
                { sessionId, action },
                {
                  onError: (err) =>
                    toast.error(`Couldn't ${action} ${name}: ${err.message}`),
                }
              );
            }}
          />
        );
      })}
    </div>
  );
}
