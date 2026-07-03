/**
 * Live-preview helpers (#28) — the pure, client-safe data layer for PreviewPanel.
 *
 * Just device presets + a URL derivation. NO node builtins, NO server-only
 * imports, so it's safe in the browser bundle and unit-tested.
 *
 * (The click-to-comment element PICKER was deferred: it requires the framed dev
 * server to be SAME-ORIGIN with Stoa so the parent can inject/read its DOM, which
 * is never true when the dev server runs on its own port. Reviving it needs a
 * same-origin dev-server proxy — tracked as a separate roadmap item. The shipped
 * preview embeds the app and sends a STRUCTURED manual comment to the worker.)
 */

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
