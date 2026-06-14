import { useState, useEffect, useRef } from "react";

/**
 * Hook for smooth drawer enter animations.
 * Uses double requestAnimationFrame to trigger CSS transition after mount.
 */
export function useDrawerAnimation(open: boolean) {
  const [isAnimatingIn, setIsAnimatingIn] = useState(false);
  const hasAnimated = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    if (open && !hasAnimated.current) {
      hasAnimated.current = true;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (mountedRef.current && openRef.current) {
            setIsAnimatingIn(true);
          }
        });
      });
    }
    if (!open) {
      hasAnimated.current = false;
      setIsAnimatingIn(false);
    }

    return () => {
      mountedRef.current = false;
    };
  }, [open]);

  return isAnimatingIn;
}
