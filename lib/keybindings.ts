/**
 * Global keyboard shortcuts — pure, DOM-free helpers so the bug-prone bits
 * (chord normalization + the "don't hijack typing" guard) are unit-testable.
 *
 * `mod` is the platform-primary modifier: ⌘ on macOS, Ctrl elsewhere. The hook
 * (useGlobalKeybindings) supplies isMac and the real event; everything here
 * operates on a minimal event/target shape so it runs under a node test env.
 */

export interface Keybinding {
  /**
   * Normalized chord, e.g. "mod+k", "alt+arrowdown". The key token is the
   * produced `event.key`, so prefer letters / digits / named keys (arrows):
   * Shift+punctuation yields the shifted glyph (Shift+/ → "shift+?") and
   * Alt+letter on macOS yields the alternate glyph (Alt+s → "alt+ß") — both are
   * layout-dependent. `mod` is the platform-primary modifier: ⌘ on macOS, Ctrl
   * elsewhere (so the conventional Cmd+K / Ctrl+K both normalize to "mod+k").
   */
  chord: string;
  /** Opaque action id dispatched to the handler. */
  action: string;
  /**
   * If true, the shortcut fires even when focus is in a text field (e.g. a
   * command palette). Defaults to false: navigation keys must NOT hijack typing.
   */
  allowInInput?: boolean;
  /** Human-readable label shown in the shortcuts cheatsheet (omit to hide). */
  description?: string;
}

/** The slice of a KeyboardEvent we read (kept minimal for testability). */
export interface KeyEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  /** True for OS auto-repeat (held key). Suppressed: actions aren't idempotent. */
  repeat?: boolean;
}

/** Modifier key names — never emitted as the chord's key token. */
const MODIFIER_KEYS = new Set([
  "shift",
  "control",
  "alt",
  "meta",
  "altgraph",
  "os",
]);

/** Duck-typed event target so the guard needs no real DOM in tests. */
export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selectors: string) => unknown;
}

/** Normalize a key name to a stable, lowercase chord token. */
function normalizeKey(key: string): string {
  if (key === " ") return "space";
  return key.toLowerCase();
}

/**
 * Build a chord string from a key event, e.g. "mod+k", "alt+shift+arrowdown".
 * Modifier order is fixed (mod, alt, shift) so chords compare as plain strings.
 * `mod` collapses ⌘ (mac) / Ctrl (others) into one platform-agnostic token.
 */
export function eventToChord(e: KeyEventLike, isMac: boolean): string {
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  // A bare modifier press (key === "Shift" etc.) must not double the token
  // ("shift+shift"); only append a real, non-modifier key.
  const key = normalizeKey(e.key);
  if (!MODIFIER_KEYS.has(key)) parts.push(key);
  return parts.join("+");
}

/**
 * True when the event target is a text-entry surface where shortcuts must not
 * fire — an input/textarea/select, a contenteditable, or anywhere inside the
 * xterm terminal — so we never steal the user's keystrokes.
 */
export function isEditableTarget(
  target: TargetLike | null | undefined
): boolean {
  if (!target) return false;
  const tag = (target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  if (typeof target.closest === "function" && target.closest(".xterm")) {
    return true;
  }
  return false;
}

/**
 * Resolve a key event to a matching binding, or null. Returns null when the
 * focus is in a text field unless the matched binding opts in via allowInInput.
 */
export function resolveShortcut(
  e: KeyEventLike & { target?: TargetLike | null },
  bindings: Keybinding[],
  isMac: boolean
): Keybinding | null {
  // Ignore OS auto-repeat: a held key would re-fire the action dozens of times
  // a second, and navigation/attach actions are not idempotent.
  if (e.repeat) return null;
  const chord = eventToChord(e, isMac);
  const hit = bindings.find((b) => b.chord === chord);
  if (!hit) return null;
  if (!hit.allowInInput && isEditableTarget(e.target)) return null;
  return hit;
}

/** Heuristic platform check for the `mod` key (⌘ vs Ctrl). */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const s = `${navigator.platform || ""} ${navigator.userAgent || ""}`;
  return /\bmac/i.test(s);
}

const MOD_GLYPHS_MAC: Record<string, string> = {
  mod: "⌘",
  alt: "⌥",
  shift: "⇧",
};
const MOD_GLYPHS_OTHER: Record<string, string> = {
  mod: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};
const KEY_GLYPHS: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  space: "Space",
  enter: "↵",
  escape: "Esc",
};

/**
 * Format a chord for display in the cheatsheet, e.g. "mod+k" -> "⌘K" on macOS,
 * "Ctrl+K" elsewhere; "alt+arrowdown" -> "⌥↓" / "Alt+↓". Pure + testable.
 */
export function formatChord(chord: string, isMac: boolean): string {
  const mods = isMac ? MOD_GLYPHS_MAC : MOD_GLYPHS_OTHER;
  const parts = chord.split("+").map((p) => {
    if (p in mods) return mods[p];
    if (p in KEY_GLYPHS) return KEY_GLYPHS[p];
    return p.length === 1 ? p.toUpperCase() : p;
  });
  // macOS convention concatenates glyphs (⌘K); elsewhere join with "+" (Ctrl+K).
  return parts.join(isMac ? "" : "+");
}
