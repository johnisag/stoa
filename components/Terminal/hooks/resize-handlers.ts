"use client";

import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

interface ResizeHandlersConfig {
  term: XTerm;
  fitAddon: FitAddon;
  containerRef: React.RefObject<HTMLDivElement | null>;
  isMobile: boolean;
  sendResize: (cols: number, rows: number) => void;
}

export function setupResizeHandlers(config: ResizeHandlersConfig): () => void {
  const { term, fitAddon, containerRef, isMobile, sendResize } = config;

  let resizeTimeout: NodeJS.Timeout | null = null;
  let fitTimeouts: NodeJS.Timeout[] = [];
  const mqListeners: { mq: MediaQueryList; handler: () => void }[] = [];
  let resizeObserver: ResizeObserver | null = null;

  // Workaround for FitAddon bug: it reserves 14px for scrollbar even when hidden
  // FitAddon uses `overviewRuler?.width || 14` which doesn't work with 0 (falsy)
  // On mobile we hide the scrollbar via CSS, so manually expand xterm-screen to full width
  const fixMobileScrollbarWidth = () => {
    if (!isMobile || !containerRef.current) return;

    const xtermScreen = containerRef.current.querySelector(
      ".xterm-screen"
    ) as HTMLElement | null;
    if (xtermScreen) {
      const containerWidth = containerRef.current.clientWidth;
      xtermScreen.style.width = `${containerWidth}px`;
    }
  };

  const doFit = () => {
    // Clear any pending fit timeouts
    fitTimeouts.forEach(clearTimeout);
    fitTimeouts = [];

    // On mobile, save scroll position before fit to prevent keyboard open/close scroll
    const savedScrollLine = isMobile ? term.buffer.active.viewportY : null;

    const restoreScroll = () => {
      if (savedScrollLine !== null) {
        term.scrollToLine(savedScrollLine);
      }
    };

    // Refit only when the grid would ACTUALLY change.
    const fitIfChanged = () => {
      const next = fitAddon.proposeDimensions();
      if (!next || (next.cols === term.cols && next.rows === term.rows)) return;
      fitAddon.fit();
      fixMobileScrollbarWidth();
      restoreScroll();
      sendResize(term.cols, term.rows);
    };

    // Single rAF fit — handles the immediate case. The ResizeObserver already
    // fires after the DOM settles, so the 100ms/250ms retries are unnecessary
    // and only generate extra SIGWINCH sends on slow layouts.
    requestAnimationFrame(fitIfChanged);

    // One safety retry at 250ms for DevTools toggle and other slow layout updates
    // that don't fire a second ResizeObserver callback. Using a single timeout
    // instead of two eliminates the redundant intermediate sendResize call.
    fitTimeouts.push(setTimeout(fitIfChanged, 250));
  };

  const handleResize = () => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(doFit, isMobile ? 100 : 50);
  };

  // Window resize
  window.addEventListener("resize", handleResize);

  // Media query listeners for Chrome DevTools mobile toggle
  const mediaQueries = [
    "(max-width: 640px)",
    "(max-width: 768px)",
    "(max-width: 1024px)",
  ];
  mediaQueries.forEach((query) => {
    const mq = window.matchMedia(query);
    const handler = () => handleResize();
    mq.addEventListener("change", handler);
    mqListeners.push({ mq, handler });
  });

  // Handle orientation change on mobile
  if (isMobile && "orientation" in screen) {
    screen.orientation.addEventListener("change", handleResize);
  }

  // Handle visual viewport changes (for mobile keyboard)
  if (isMobile && window.visualViewport) {
    window.visualViewport.addEventListener("resize", handleResize);
  }

  // ResizeObserver for container changes
  if (containerRef.current) {
    resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(containerRef.current);
  }

  // Return cleanup function
  return () => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    fitTimeouts.forEach(clearTimeout);

    window.removeEventListener("resize", handleResize);

    mqListeners.forEach(({ mq, handler }) => {
      mq.removeEventListener("change", handler);
    });

    if (isMobile && "orientation" in screen) {
      screen.orientation.removeEventListener("change", handleResize);
    }

    if (isMobile && window.visualViewport) {
      window.visualViewport.removeEventListener("resize", handleResize);
    }

    if (resizeObserver) {
      resizeObserver.disconnect();
    }
  };
}
