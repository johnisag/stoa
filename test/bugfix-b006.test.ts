/**
 * B006 — getActiveBackend() must not cache the fallback on a TRANSIENT failure.
 *
 * The module caches the probed backend after the first successful fetch. A
 * fetch failure used to write `cached = "tmux"`, permanently locking the client
 * to tmux for the page lifetime (breaking pty/Windows attach) even though the
 * very next probe would have succeeded. The fix returns "tmux" as a one-shot
 * fallback WITHOUT writing `cached`, so the next call re-probes.
 *
 * Mocks the server-only modules backend.ts imports at load (providers /
 * model-catalog) so it runs on every OS, and stubs global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// backend.ts imports these at load; getActiveBackend never touches them.
vi.mock("@/lib/providers", () => ({
  getProvider: vi.fn(),
  buildAgentArgs: vi.fn(),
}));
vi.mock("@/lib/model-catalog", () => ({ resolveModelForAgent: vi.fn() }));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules(); // reset backend.ts's module-level `cached` between tests
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(backend: string) {
  return { json: async () => ({ backend }) } as unknown as Response;
}

describe("getActiveBackend — transient failure must not lock the client (B006)", () => {
  it("re-probes after a transient failure instead of caching the fallback", async () => {
    const { getActiveBackend } = await import("@/lib/client/backend");

    // First call: fetch rejects -> one-shot "tmux" fallback, NOT cached.
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await getActiveBackend()).toBe("tmux");

    // Second call: the server is reachable and reports pty. Because the failure
    // was not cached, the probe runs again and we correctly get "pty".
    fetchMock.mockResolvedValueOnce(okResponse("pty"));
    expect(await getActiveBackend()).toBe("pty");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches a SUCCESSFUL probe (no redundant re-fetch)", async () => {
    const { getActiveBackend } = await import("@/lib/client/backend");

    fetchMock.mockResolvedValueOnce(okResponse("pty"));
    expect(await getActiveBackend()).toBe("pty");

    // Cached — no second fetch.
    expect(await getActiveBackend()).toBe("pty");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a non-pty backend to tmux and caches it", async () => {
    const { getActiveBackend } = await import("@/lib/client/backend");

    fetchMock.mockResolvedValueOnce(okResponse("tmux"));
    expect(await getActiveBackend()).toBe("tmux");
    expect(await getActiveBackend()).toBe("tmux");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("repeated transient failures keep re-probing (never gets stuck)", async () => {
    const { getActiveBackend } = await import("@/lib/client/backend");

    fetchMock.mockRejectedValueOnce(new Error("boom"));
    expect(await getActiveBackend()).toBe("tmux");
    fetchMock.mockRejectedValueOnce(new Error("boom again"));
    expect(await getActiveBackend()).toBe("tmux");

    // Server finally recovers -> pty, proving nothing was permanently cached.
    fetchMock.mockResolvedValueOnce(okResponse("pty"));
    expect(await getActiveBackend()).toBe("pty");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
