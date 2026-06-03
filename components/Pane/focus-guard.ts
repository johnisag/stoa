/** Minimal shape of a terminal handle this guard needs (avoids importing the
 * heavy Terminal module — keeps the predicate unit-testable in a node env). */
interface SelectableTerminal {
  hasSelection?: () => boolean;
}

/**
 * Whether a click on a pane should grab focus.
 *
 * It must NOT when the pane's terminal holds a text selection: `term.focus()`
 * clears the xterm selection on the mouse-up `click` that completes a
 * drag-select, so the user can't copy it. The xterm selection is its own model
 * (the canvas/WebGL renderer paints it), NOT a DOM Selection, so we ask the
 * terminal handle rather than `window.getSelection()`. A plain click with no
 * selection still focuses.
 */
export function shouldFocusPaneOnClick(
  terminal: SelectableTerminal | null
): boolean {
  return !terminal?.hasSelection?.();
}
