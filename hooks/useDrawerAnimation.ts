import { useState, useEffect, useRef } from "react";

/**
 * Hook for smooth drawer enter/exit animations.
 * Returns { isAnimatingIn, isClosing }.
 * The caller should keep the drawer mounted while isClosing is true and
 * apply the inverse of the enter transform classes.
 */
export function useDrawerAnimation(
  open: boolean,
  exitDurationMs = 200
) {
  const [isAnimatingIn, setIsAnimatingIn] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const hasAnimated = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    if (open) {
      setIsClosing(false);
      if (!hasAnimated.current) {
        hasAnimated.current = true;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (mountedRef.current && openRef.current) {
              setIsAnimatingIn(true);
            }
          });
        });
      }
    } else {
      hasAnimated.current = false;
      setIsAnimatingIn(false);
      setIsClosing(true);
      const t = setTimeout(() => {
        if (mountedRef.current) setIsClosing(false);
      }, exitDurationMs);
      return () => clearTimeout(t);
    }

    return () => {
      mountedRef.current = false;
    };
  }, [open, exitDurationMs]);

  return { isAnimatingIn, isClosing };
}
