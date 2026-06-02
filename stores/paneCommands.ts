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
  | "prev-tab";

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

export const paneCommandActions = {
  send: (command: PaneCommand) => {
    paneCommandStore.request = { command, id: Date.now() };
  },
  clear: () => {
    paneCommandStore.request = null;
  },
};
