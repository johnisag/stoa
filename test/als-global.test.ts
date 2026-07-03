/**
 * The AsyncLocalStorage startup guard (server.ts's first import). It MUST leave
 * `globalThis.AsyncLocalStorage` populated with the real async_hooks class —
 * Next.js's app-render reads exactly that global, and without it the custom
 * production server crashes at startup with the E504 invariant (reproduced on
 * Node 24.11.1 + Next 16 + tsx). It must also be idempotent: never overwrite a
 * value the runtime/Next already provided. Both branches exercise the REAL
 * exported function so a regression (e.g. dropping the `if (!…)` guard) fails.
 */
import { describe, it, expect, afterEach } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { installAsyncLocalStorageGlobal } from "@/lib/als-global";

const g = globalThis as unknown as { AsyncLocalStorage?: unknown };

// Importing the module already ran the side-effect once; snapshot the real class
// so we can restore it after each test (other suites may rely on the global).
afterEach(() => {
  g.AsyncLocalStorage = AsyncLocalStorage;
});

describe("installAsyncLocalStorageGlobal (startup E504 guard)", () => {
  it("populates globalThis.AsyncLocalStorage with the real async_hooks class when absent", () => {
    delete g.AsyncLocalStorage;
    installAsyncLocalStorageGlobal();
    expect(g.AsyncLocalStorage).toBe(AsyncLocalStorage);
    // It actually works as an ALS (round-trips a store through .run()).
    const als = new (g.AsyncLocalStorage as typeof AsyncLocalStorage)<number>();
    expect(als.run(42, () => als.getStore())).toBe(42);
  });

  it("does NOT overwrite an AsyncLocalStorage already on the global (idempotent)", () => {
    const sentinel: unknown = class Existing {};
    g.AsyncLocalStorage = sentinel;
    installAsyncLocalStorageGlobal(); // the REAL guard — must leave the sentinel
    expect(g.AsyncLocalStorage).toBe(sentinel);
  });
});
