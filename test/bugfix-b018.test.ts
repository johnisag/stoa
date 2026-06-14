// @vitest-environment jsdom
/**
 * Regression test for B018 — ServerLogsModal stale-response race.
 *
 * Root cause: `fetchLogs` had no in-flight cancellation. The per-serverId
 * initial fetch (and the 3s auto-refresh) could overlap, so a slow response
 * for the OLD serverId could land after `serverId` changed and `setLogs` the
 * previous server's logs into the now-current view.
 *
 * Fix: each effect run owns a `{ cancelled }` token, flipped to true on
 * unmount / serverId change; `fetchLogs` ignores any response whose token is
 * cancelled. This test drives a slow old-server response that resolves AFTER
 * the new server's response and asserts the stale logs never win.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import React from "react";
import { ServerLogsModal } from "@/components/DevServers/ServerLogsModal";

type Deferred = {
  resolve: (logs: string[]) => void;
  promise: Promise<Response>;
};

function makeDeferred(): Deferred {
  let resolveFn!: (logs: string[]) => void;
  const promise = new Promise<Response>((res) => {
    resolveFn = (logs: string[]) =>
      res({
        ok: true,
        json: async () => ({ logs }),
      } as Response);
  });
  return { resolve: resolveFn, promise };
}

describe("ServerLogsModal — ignores stale logs after serverId change (B018)", () => {
  const deferreds = new Map<string, Deferred>();

  beforeEach(() => {
    deferreds.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        // Key the deferred by the serverId embedded in the URL so the test can
        // resolve the OLD and NEW fetches in a controlled (out-of-order) order.
        const match = /dev-servers\/([^/]+)\/logs/.exec(url);
        const id = match ? match[1] : "unknown";
        const d = makeDeferred();
        deferreds.set(id, d);
        return d.promise;
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not write the previous server's logs after serverId switches", async () => {
    const { rerender } = render(
      React.createElement(ServerLogsModal, {
        serverId: "old",
        serverName: "old-server",
        onClose: () => {},
      })
    );

    // The initial fetch for "old" is now in flight (unresolved).
    expect(deferreds.has("old")).toBe(true);
    const oldFetch = deferreds.get("old")!;

    // Switch to a new server BEFORE the old fetch resolves. The effect cleanup
    // must cancel the old run's token.
    rerender(
      React.createElement(ServerLogsModal, {
        serverId: "new",
        serverName: "new-server",
        onClose: () => {},
      })
    );
    expect(deferreds.has("new")).toBe(true);
    const newFetch = deferreds.get("new")!;

    // Resolve the NEW (current) fetch first, then the stale OLD one.
    await act(async () => {
      newFetch.resolve(["NEW-LOG-LINE"]);
      await newFetch.promise;
    });
    await act(async () => {
      oldFetch.resolve(["OLD-STALE-LINE"]);
      await oldFetch.promise;
    });

    // The stale "old" response must have been ignored: only the new logs show.
    expect(screen.queryByText("NEW-LOG-LINE")).not.toBeNull();
    expect(screen.queryByText("OLD-STALE-LINE")).toBeNull();
  });
});
