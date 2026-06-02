"use client";

import { useState, useEffect } from "react";

/**
 * Mobile-first viewport detection hook
 * Breakpoint: 768px (md in Tailwind)
 */
export function useViewport() {
  // Lazy-init from the real width on the client so the first post-hydration
  // render already has the correct value (no extra effect-driven flip). SSR has
  // no window, so it falls back to false — but the view is gated on `isHydrated`
  // (see app/page.tsx), so that SSR default is never shown as a wrong view.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 768 : false
  );
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    const checkViewport = () => {
      setIsMobile(window.innerWidth < 768);
    };

    // Initial check
    checkViewport();
    setIsHydrated(true);

    // Listen for resize
    window.addEventListener("resize", checkViewport);
    return () => window.removeEventListener("resize", checkViewport);
  }, []);

  return {
    isMobile,
    isDesktop: !isMobile,
    isHydrated, // For avoiding hydration mismatches
  };
}
