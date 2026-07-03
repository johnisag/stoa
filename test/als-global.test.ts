/**
 * The AsyncLocalStorage startup guard (server.ts's first import). Importing it
 * MUST leave `globalThis.AsyncLocalStorage` populated with the real async_hooks
 * class — Next.js's app-render reads exactly that global, and without it the
 * custom production server crashes at startup with the E504 invariant
 * (reproduced on Node 24.11.1 + Next 16 + tsx). It must also be idempotent: it
 * never overwrites a value the runtime/Next already provided.
 */
import { describe, it, expect } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";

const g = globalThis as unknown as { AsyncLocalStorage?: unknown };

describe("lib/als-global (startup E504 guard)", () => {
  it("populates globalThis.AsyncLocalStorage with the real async_hooks class", async () => {
    delete g.AsyncLocalStorage; // clear any pre-existing value
    await import("@/lib/als-global");
    expect(g.AsyncLocalStorage).toBe(AsyncLocalStorage);
    // It actually works as an ALS (round-trips a store through .run()).
    const als = new (g.AsyncLocalStorage as typeof AsyncLocalStorage)<number>();
    expect(als.run(42, () => als.getStore())).toBe(42);
  });

  it("does NOT overwrite an AsyncLocalStorage already on the global (idempotent)", () => {
    const sentinel: unknown = class Existing {};
    g.AsyncLocalStorage = sentinel;
    // The guard's rule: only fill when absent — a present value is left alone.
    if (!g.AsyncLocalStorage) g.AsyncLocalStorage = AsyncLocalStorage;
    expect(g.AsyncLocalStorage).toBe(sentinel);
    g.AsyncLocalStorage = AsyncLocalStorage; // restore so later tests are unaffected
  });
});
