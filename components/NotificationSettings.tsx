"use client";

import { Bell, Volume2, VolumeX, AlertCircle, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useWebPush } from "@/hooks/useWebPush";
import type { NotificationSettings as NotificationSettingsType } from "@/lib/notifications";

interface WaitingSession {
  id: string;
  name: string;
}

interface NotificationSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: NotificationSettingsType;
  permissionGranted: boolean;
  waitingSessions?: WaitingSession[];
  onUpdateSettings: (settings: Partial<NotificationSettingsType>) => void;
  onRequestPermission: () => Promise<boolean>;
  onSelectSession?: (id: string) => void;
  /**
   * Mobile presentation: render the settings as a bottom-sheet driven purely by
   * `open`/`onOpenChange`, without the Bell dropdown trigger (the trigger lives
   * elsewhere, e.g. the SidebarFooter Bell). Default (false) keeps the desktop
   * header dropdown unchanged.
   */
  hideTrigger?: boolean;
}

export function NotificationSettings({
  open,
  onOpenChange,
  settings,
  permissionGranted,
  waitingSessions = [],
  onUpdateSettings,
  onRequestPermission,
  onSelectSession,
  hideTrigger = false,
}: NotificationSettingsProps) {
  const waitingCount = waitingSessions.length;
  const webPush = useWebPush();

  // The menu body is identical across both presentations; only the wrapper
  // differs (anchored dropdown on desktop vs. bottom-sheet overlay on mobile).
  const body = (
    <>
      {/* Waiting sessions section */}
      {waitingCount > 0 && (
        <>
          <DropdownMenuLabel className="flex items-center gap-2 text-xs text-yellow-500">
            <AlertCircle className="h-3 w-3" />
            Waiting for input
          </DropdownMenuLabel>
          {waitingSessions.map((session) => (
            <DropdownMenuItem
              key={session.id}
              onClick={() => {
                onSelectSession?.(session.id);
                onOpenChange(false);
              }}
              className="text-sm"
            >
              {session.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
        </>
      )}

      {/* Sound toggle */}
      <DropdownMenuItem
        onClick={() => onUpdateSettings({ sound: !settings.sound })}
        className="flex items-center justify-between"
      >
        <span className="flex items-center gap-2">
          {settings.sound ? (
            <Volume2 className="h-3 w-3" />
          ) : (
            <VolumeX className="text-muted-foreground h-3 w-3" />
          )}
          Sound
        </span>
        <span
          className={cn(
            "relative h-4 w-8 rounded-full transition-colors",
            settings.sound ? "bg-primary" : "bg-muted"
          )}
        >
          <span
            className={cn(
              "bg-background absolute top-0.5 h-3 w-3 rounded-full transition-transform",
              settings.sound ? "translate-x-4" : "translate-x-0.5"
            )}
          />
        </span>
      </DropdownMenuItem>

      {/* Per-event toggles: which transitions notify you */}
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-muted-foreground text-xs">
        Notify me when a session…
      </DropdownMenuLabel>
      {(
        [
          ["waiting", "Needs input"],
          ["error", "Hits an error"],
          ["completed", "Finishes"],
        ] as const
      ).map(([event, label]) => {
        const on = settings.events[event];
        return (
          <DropdownMenuItem
            key={event}
            onSelect={(e) => {
              e.preventDefault();
              onUpdateSettings({
                events: { ...settings.events, [event]: !on },
              });
            }}
            className="flex items-center justify-between"
          >
            <span>{label}</span>
            <span
              className={cn(
                "relative h-4 w-8 rounded-full transition-colors",
                on ? "bg-primary" : "bg-muted"
              )}
            >
              <span
                className={cn(
                  "bg-background absolute top-0.5 h-3 w-3 rounded-full transition-transform",
                  on ? "translate-x-4" : "translate-x-0.5"
                )}
              />
            </span>
          </DropdownMenuItem>
        );
      })}

      {/* Browser notifications - only show if not granted */}
      {!permissionGranted && (
        <DropdownMenuItem
          onClick={async () => {
            await onRequestPermission();
          }}
        >
          <Bell className="mr-2 h-3 w-3" />
          <span className="text-xs">Enable browser alerts</span>
        </DropdownMenuItem>
      )}

      {/* Closed-tab (Web Push) notifications — once browser alerts are on and
            the SW/secure-context is available. */}
      {permissionGranted && webPush.supported && (
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            if (webPush.busy) return;
            if (webPush.subscribed) void webPush.unsubscribe();
            else void webPush.subscribe();
          }}
          className="flex items-center justify-between"
        >
          <span className="text-xs">Notify even when tab is closed</span>
          <span
            className={cn(
              "relative h-4 w-8 rounded-full transition-colors",
              webPush.subscribed ? "bg-primary" : "bg-muted"
            )}
          >
            <span
              className={cn(
                "bg-background absolute top-0.5 h-3 w-3 rounded-full transition-transform",
                webPush.subscribed ? "translate-x-4" : "translate-x-0.5"
              )}
            />
          </span>
        </DropdownMenuItem>
      )}

      {/* Diagnostic: fire a known test push so you can confirm on demand how a
            closed-tab notification renders (text + action buttons) on this device. */}
      {permissionGranted && webPush.supported && webPush.subscribed && (
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            void webPush.sendTest().then((ok) => {
              if (ok) toast.success("Test notification sent");
              else toast.error("Couldn't send test notification");
            });
          }}
          className="text-xs"
        >
          <Send className="mr-2 h-3 w-3" />
          Send test notification
        </DropdownMenuItem>
      )}
    </>
  );

  // Mobile: no Bell trigger here (it lives in the SidebarFooter). Present the
  // same body as a bottom-sheet overlay driven purely by `open`/`onOpenChange`.
  // The menu items are Radix DropdownMenu primitives, so keep them inside a
  // DropdownMenu root — here it's a controlled, always-open menu anchored to a
  // hidden bottom-centered point, styled to read as a sheet.
  if (hideTrigger) {
    if (!open) return null;
    return (
      <DropdownMenu open onOpenChange={onOpenChange}>
        <DropdownMenuTrigger
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed bottom-[calc(0.5rem+env(safe-area-inset-bottom))] left-1/2 h-0 w-0 -translate-x-1/2"
        />
        <DropdownMenuContent
          side="top"
          align="center"
          sideOffset={8}
          className="max-h-[60vh] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto"
        >
          {body}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // Desktop: anchored dropdown with the Bell trigger (unchanged).
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative">
          <Bell
            className={cn(
              "h-4 w-4",
              !settings.sound && "text-muted-foreground"
            )}
          />
          {waitingCount > 0 && (
            <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-yellow-500 text-[10px] font-bold text-yellow-950">
              {waitingCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {body}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
