"use client";

import type { Terminal as XTerm } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";

/**
 * Attach a GPU renderer to an already-`open()`ed terminal.
 *
 * WebGL renders each frame cleanly. The CanvasAddon (the previous renderer)
 * ghosts/overlaps glyphs under rapid full-screen redraws — e.g. agent spinners
 * and parallel sub-agent progress — leaving the terminal unreadable during
 * exactly the busy moments that matter.
 *
 * Fallbacks keep the terminal rendering rather than freezing:
 *  - WebGL unavailable (no GPU / headless / blocked) → CanvasAddon.
 *  - WebGL context lost at runtime (tab backgrounded, driver reset) → dispose
 *    WebGL and swap to CanvasAddon so it doesn't freeze on a dead context.
 *  - If even canvas throws, fall through to xterm's built-in DOM renderer.
 *
 * The optional `deps` argument is used by tests to inject mock addons without
 * relying on module mocking in headless/VM test pools.
 *
 * Returns which renderer was attached (useful for diagnostics/tests).
 */
export function loadRenderer(
  term: XTerm,
  deps: {
    WebglAddon?: typeof WebglAddon;
    CanvasAddon?: typeof CanvasAddon;
  } = {}
): "webgl" | "canvas" {
  const Webgl = deps.WebglAddon ?? WebglAddon;
  const Canvas = deps.CanvasAddon ?? CanvasAddon;

  try {
    const webgl = new Webgl();
    webgl.onContextLoss(() => {
      webgl.dispose();
      try {
        term.loadAddon(new Canvas());
      } catch {
        /* DOM renderer (no addon) is the last resort */
      }
    });
    term.loadAddon(webgl);
    return "webgl";
  } catch {
    try {
      term.loadAddon(new Canvas());
    } catch {
      /* fall through to xterm's built-in DOM renderer */
    }
    return "canvas";
  }
}
