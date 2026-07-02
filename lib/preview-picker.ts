/**
 * Live-preview element picker (#28) — the pure, DOM-free half.
 *
 * The picker lets a user click an element in the embedded dev-server iframe and
 * turn it into a STRUCTURED locator (tag + nearest id/data-testid + text snippet +
 * short DOM path), NOT a screenshot. Because a browser refuses to let a parent
 * page read the DOM of a CROSS-ORIGIN iframe, introspection has to run INSIDE the
 * iframe: the parent injects a tiny script (buildPickerScript) into the same-origin
 * dev-server document, and that script posts the captured locator back over
 * `postMessage`. The parent validates the envelope here (parsePickerMessage) before
 * trusting a single field.
 *
 * CROSS-ORIGIN LIMITATION (documented, feature-detected at the call site): the
 * parent can only inject/read a SAME-ORIGIN document. For a cross-origin preview
 * URL the picker degrades to a manual note (the user types the locator by hand).
 * `canInjectPicker` is the pure origin test the UI uses to decide.
 *
 * This module is client-safe: NO node builtins, NO server-only imports — it is a
 * string builder + a message validator, both pure and unit-tested.
 */

import type { PreviewLocator } from "./diff-comment";

/** The postMessage `type` the injected picker stamps on its payload so the parent
 * can distinguish our envelope from unrelated cross-frame chatter. */
export const PICKER_MESSAGE_TYPE = "stoa:preview-picker";

/** The shape the injected script posts back (before normalization). */
export interface PickerMessage {
  type: typeof PICKER_MESSAGE_TYPE;
  locator: Partial<PreviewLocator>;
}

/**
 * Whether the parent page (at `parentOrigin`) may inject the picker into a preview
 * at `previewUrl`. Same-origin only — a cross-origin document can neither be
 * scripted nor read, so the picker must fall back to a manual note. Pure → tested.
 * A malformed `previewUrl` returns false (fail-closed to manual).
 */
export function canInjectPicker(
  previewUrl: string,
  parentOrigin: string
): boolean {
  let target: URL;
  let parent: URL;
  try {
    target = new URL(previewUrl);
    parent = new URL(parentOrigin);
  } catch {
    return false;
  }
  return target.origin === parent.origin;
}

/**
 * Validate + narrow an untrusted `MessageEvent.data` into a PickerMessage, or
 * null if it isn't one. Pure → tested. Does NOT normalize the locator fields
 * (that is normalizeLocator's job) — only asserts the envelope shape so a random
 * postMessage from the framed app (analytics, HMR, etc.) is ignored.
 */
export function parsePickerMessage(data: unknown): PickerMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.type !== PICKER_MESSAGE_TYPE) return null;
  const loc = d.locator;
  if (typeof loc !== "object" || loc === null) return null;
  // Shallow-copy only the known string-ish fields; ignore anything extra.
  const l = loc as Record<string, unknown>;
  const pick = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  return {
    type: PICKER_MESSAGE_TYPE,
    locator: {
      tag: pick(l.tag),
      id: pick(l.id),
      testId: pick(l.testId),
      text: pick(l.text),
      domPath: pick(l.domPath),
      url: pick(l.url),
    },
  };
}

/**
 * Build the self-contained IIFE string the parent injects into the SAME-ORIGIN
 * preview document. When active it hovers-highlights and, on the next click,
 * captures a structured locator and posts it to `targetOrigin`, then deactivates.
 *
 * It is a string (not a real function) because it must run in the iframe's realm,
 * reached via `iframe.contentWindow` script injection. The only interpolated value
 * is `targetOrigin`, which comes from the parent's own `window.location.origin`
 * (never user input) and is passed as the explicit `postMessage` targetOrigin so
 * the locator is only ever delivered back to us. Kept tiny and dependency-free.
 *
 * `messageType` is a constant baked in from PICKER_MESSAGE_TYPE so the string and
 * the parser can't drift.
 */
export function buildPickerScript(targetOrigin: string): string {
  // JSON.stringify safely escapes the origin/type for embedding in the source.
  const originLit = JSON.stringify(targetOrigin);
  const typeLit = JSON.stringify(PICKER_MESSAGE_TYPE);
  return `(function () {
  var TARGET = ${originLit};
  var TYPE = ${typeLit};
  if (window.__stoaPicker) { window.__stoaPicker.stop(); }
  function pathOf(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      var seg = node.tagName ? node.tagName.toLowerCase() : "";
      if (node.id) { seg += "#" + node.id; parts.unshift(seg); break; }
      if (node.classList && node.classList.length) {
        seg += "." + Array.prototype.slice.call(node.classList, 0, 2).join(".");
      }
      parts.unshift(seg);
      node = node.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }
  function capture(el) {
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : "element",
      id: el.id || null,
      testId: el.getAttribute ? el.getAttribute("data-testid") : null,
      text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160),
      domPath: pathOf(el),
      url: window.location.href
    };
  }
  var last = null;
  function highlight(el) {
    if (last) { last.style.outline = last.__stoaPrevOutline || ""; }
    if (el && el.style) {
      el.__stoaPrevOutline = el.style.outline;
      el.style.outline = "2px solid #3b82f6";
      last = el;
    }
  }
  function onMove(e) { highlight(e.target); }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    var loc = capture(e.target);
    window.parent.postMessage({ type: TYPE, locator: loc }, TARGET);
    stop();
  }
  function stop() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    if (last) { last.style.outline = last.__stoaPrevOutline || ""; last = null; }
    window.__stoaPicker = null;
  }
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  window.__stoaPicker = { stop: stop };
})();`;
}

/** Device presets for the preview iframe width. Height is left to the container
 * so the frame scrolls; only width matters for responsive checks. Pure data. */
export interface DevicePreset {
  id: string;
  label: string;
  /** CSS width in px, or null for "full" (fill the panel). */
  width: number | null;
}

export const DEVICE_PRESETS: readonly DevicePreset[] = [
  { id: "phone", label: "Phone", width: 390 },
  { id: "tablet", label: "Tablet", width: 820 },
  { id: "desktop", label: "Desktop", width: 1280 },
  { id: "full", label: "Full", width: null },
] as const;

/**
 * Derive a preview URL from a project's configured dev-server ports. Pure →
 * unit-tested. Picks the FIRST configured port (deterministic — the list is
 * already sort_order-ordered by the query) and builds a localhost URL. Returns
 * null when no port is configured, so the UI can hide the Preview affordance
 * rather than open a dead frame. `dev-servers.ts` tracks the live PORT; the
 * configured port here is the stable, always-available handle the session card
 * has without a live server-status fetch.
 */
export function previewUrlFromPorts(
  ports: readonly (number | null | undefined)[]
): string | null {
  for (const p of ports) {
    if (typeof p === "number" && Number.isInteger(p) && p > 0 && p < 65536) {
      return `http://localhost:${p}`;
    }
  }
  return null;
}
