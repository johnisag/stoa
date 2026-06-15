import { describe, it, expect } from "vitest";
import { paneCommandActions, paneCommandStore } from "@/stores/paneCommands";

// Regression: command id was Date.now(), which collides on a sub-ms repeat so the
// consumer effect (keyed on id) swallowed the second command. Now monotonic.
describe("paneCommandActions.send — monotonic ids", () => {
  it("gives every send a strictly-increasing id, even back-to-back", () => {
    paneCommandActions.send("next-tab");
    const first = paneCommandStore.request!.id;
    paneCommandActions.send("next-tab"); // identical command, immediately
    const second = paneCommandStore.request!.id;
    paneCommandActions.send("prev-tab");
    const third = paneCommandStore.request!.id;

    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it("clear() resets the request", () => {
    paneCommandActions.send("toggle-git");
    expect(paneCommandStore.request).not.toBeNull();
    paneCommandActions.clear();
    expect(paneCommandStore.request).toBeNull();
  });
});
