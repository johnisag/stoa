import { proxy } from "valtio";

/**
 * A keyboard-driven command aimed at the *focused* pane. A global shortcut
 * handler lives above the panes and can't reach a pane's local view/drawer/tab
 * state, so it drops a command here and the focused `Pane` consumes it — exactly
 * the request/clear pattern of the fileOpen store. Only the focused pane reacts,
 * then clears the request so it doesn't re-fire.
 */
export type PaneCommand =
  | "toggle-git"
  | "toggle-files"
  | "toggle-shell"
  | "next-tab"
  | "prev-tab"
  // #53 jump between command blocks (prompt-boundary navigation) in the focused
  // pane's terminal — routed here so the global shortcut reaches the pane's
  // terminal handle without lifting its ref up.
  | "jump-prev-block"
  | "jump-next-block";

export interface PaneCommandRequest {
  command: PaneCommand;
  /** Distinguishes repeats of the same command so the consumer effect re-fires. */
  id: number;
}

export const paneCommandStore = proxy<{
  request: PaneCommandRequest | null;
}>({
  request: null,
});

// Strictly-monotonic id so two sends in the SAME millisecond still differ — a
// Date.now() id could collide on key-repeat and the consumer effect (which keys
// on `id`) would swallow the second command.
let nextCommandId = 0;

export const paneCommandActions = {
  send: (command: PaneCommand) => {
    paneCommandStore.request = { command, id: ++nextCommandId };
  },
  clear: () => {
    paneCommandStore.request = null;
  },
};
