import { describe, it, expect, beforeEach } from "vitest";
import { paneCommandStore, paneCommandActions } from "@/stores/paneCommands";

// The store is the bus a global keyboard chord uses to reach the focused Pane
// (which can't be reached directly because its view/drawer/tab state is local).
// The focused pane reads `request`, acts, then calls clear() — these tests lock
// that contract.
describe("paneCommandStore", () => {
  beforeEach(() => paneCommandActions.clear());

  it("send() publishes a request carrying the command", () => {
    paneCommandActions.send("toggle-git");
    expect(paneCommandStore.request?.command).toBe("toggle-git");
  });

  it("send() overwrites the previous request (latest command wins)", () => {
    paneCommandActions.send("next-tab");
    paneCommandActions.send("toggle-shell");
    expect(paneCommandStore.request?.command).toBe("toggle-shell");
  });

  it("clear() resets the request to null so the consumer effect stops firing", () => {
    paneCommandActions.send("toggle-files");
    paneCommandActions.clear();
    expect(paneCommandStore.request).toBeNull();
  });
});
