import { Circle, Loader2, AlertCircle } from "lucide-react";
import type { SessionStatus } from "./views/types";

type StatusValue = SessionStatus["status"];

/**
 * Small status glyph mirroring SessionCard's convention. Single source so the
 * sidebar rail, QuickSwitcher, and per-pane tabs all render status identically
 * (extracted from SidebarRail to avoid drift).
 */
export function statusGlyph(status: StatusValue | undefined) {
  switch (status) {
    case "running":
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />;
    case "waiting":
      return (
        <AlertCircle className="h-3.5 w-3.5 animate-pulse text-yellow-500" />
      );
    case "error":
      return <Circle className="h-2.5 w-2.5 fill-current text-red-500" />;
    case "idle":
      return (
        <Circle className="text-muted-foreground h-2.5 w-2.5 fill-current" />
      );
    default:
      return <Circle className="text-muted-foreground/50 h-2.5 w-2.5" />;
  }
}
