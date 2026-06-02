/**
 * Locks the renderer fallback contract (terminal-renderer.ts): WebGL is the
 * primary renderer (fixes the CanvasAddon glyph-ghosting under heavy redraws),
 * and it must gracefully fall back to canvas when WebGL is unavailable or its
 * context is lost — so the terminal always renders rather than freezing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture constructions + the registered context-loss handler.
const webglCtor = vi.fn();
const canvasCtor = vi.fn();
let contextLossHandler: (() => void) | null = null;
let webglShouldThrow = false;
const webglDispose = vi.fn();

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    constructor() {
      webglCtor();
      if (webglShouldThrow) throw new Error("WebGL unavailable");
    }
    onContextLoss(cb: () => void) {
      contextLossHandler = cb;
    }
    dispose() {
      webglDispose();
    }
  },
}));
vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: class {
    constructor() {
      canvasCtor();
    }
  },
}));

import { loadRenderer } from "@/components/Terminal/hooks/terminal-renderer";

function fakeTerm() {
  return { loadAddon: vi.fn() } as unknown as Parameters<
    typeof loadRenderer
  >[0];
}

describe("loadRenderer — WebGL with canvas fallback", () => {
  beforeEach(() => {
    webglCtor.mockClear();
    canvasCtor.mockClear();
    webglDispose.mockClear();
    contextLossHandler = null;
    webglShouldThrow = false;
  });

  it("attaches WebGL when available (not canvas)", () => {
    const term = fakeTerm();
    const used = loadRenderer(term);
    expect(used).toBe("webgl");
    expect(webglCtor).toHaveBeenCalledTimes(1);
    expect(canvasCtor).not.toHaveBeenCalled();
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
  });

  it("falls back to canvas when WebGL construction throws", () => {
    webglShouldThrow = true;
    const term = fakeTerm();
    const used = loadRenderer(term);
    expect(used).toBe("canvas");
    expect(canvasCtor).toHaveBeenCalledTimes(1);
    expect(term.loadAddon).toHaveBeenCalledTimes(1); // the canvas addon
  });

  it("swaps to canvas if the WebGL context is lost at runtime", () => {
    const term = fakeTerm();
    loadRenderer(term);
    expect(contextLossHandler).toBeTypeOf("function");
    canvasCtor.mockClear();

    contextLossHandler?.(); // simulate GPU context loss

    expect(webglDispose).toHaveBeenCalledTimes(1);
    expect(canvasCtor).toHaveBeenCalledTimes(1);
  });
});
