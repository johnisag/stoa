"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SwipeSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
  children: ReactNode;
}

/** px from the left screen edge that starts an open-swipe when closed. */
const EDGE_ZONE = 20;
/** px a drag must travel to commit (open or close). */
const COMMIT_THRESHOLD = 50;

/**
 * Mobile sidebar with swipe gestures
 * Slides in from left, backdrop dismissal. Swipe left to close; swipe right
 * from the left screen edge to open (the only other open path is the hamburger).
 */
export function SwipeSidebar({
  isOpen,
  onClose,
  onOpen,
  children,
}: SwipeSidebarProps) {
  const sidebarRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef<number | null>(null);
  const touchCurrentX = useRef<number | null>(null);

  // Handle swipe-to-close (when open) and edge-swipe-to-open (when closed).
  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (isOpen) {
        // Close: only start if the touch begins within the open sidebar.
        const sidebar = sidebarRef.current;
        if (sidebar && touch.clientX <= sidebar.offsetWidth) {
          touchStartX.current = touch.clientX;
        }
      } else if (touch.clientX < EDGE_ZONE) {
        // Open: only start from the left screen edge.
        touchStartX.current = touch.clientX;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (touchStartX.current === null) return;
      touchCurrentX.current = e.touches[0].clientX;
      const diff = touchCurrentX.current - touchStartX.current;
      const sidebar = sidebarRef.current;
      if (!sidebar) return;

      if (isOpen) {
        // Drag left to peel the open sidebar off-screen (rubber-band).
        if (diff < 0) sidebar.style.transform = `translateX(${diff}px)`;
      } else if (diff > 0) {
        // Drag right to pull the closed sidebar in from -100% (clamped).
        const w = sidebar.offsetWidth || 280;
        const shown = Math.min(diff, w);
        sidebar.style.transform = `translateX(${shown - w}px)`;
      }
    };

    const handleTouchEnd = () => {
      if (touchStartX.current === null || touchCurrentX.current === null) {
        touchStartX.current = null;
        touchCurrentX.current = null;
        return;
      }

      const diff = touchCurrentX.current - touchStartX.current;
      if (isOpen && diff < -COMMIT_THRESHOLD) onClose();
      else if (!isOpen && diff > COMMIT_THRESHOLD) onOpen();

      // Reset inline transform → falls back to the open/closed CSS class.
      if (sidebarRef.current) sidebarRef.current.style.transform = "";
      touchStartX.current = null;
      touchCurrentX.current = null;
    };

    document.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    document.addEventListener("touchmove", handleTouchMove, { passive: true });
    document.addEventListener("touchend", handleTouchEnd);

    return () => {
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
    };
  }, [isOpen, onClose, onOpen]);

  // Prevent body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden",
          isOpen ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={onClose}
      />

      {/* Sidebar */}
      <aside
        ref={sidebarRef}
        className={cn(
          "bg-background fixed top-0 bottom-0 left-0 z-50 w-[280px] transition-transform duration-300 md:hidden",
          "flex flex-col",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Content */}
        <div className="flex-1 overflow-y-auto">{children}</div>

        {/* Safe area spacer */}
        <div className="h-[env(safe-area-inset-bottom)]" />
      </aside>
    </>
  );
}
