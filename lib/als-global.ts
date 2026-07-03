/**
 * Ensure `globalThis.AsyncLocalStorage` is set BEFORE Next.js is imported.
 *
 * Next's app-render reads `globalThis.AsyncLocalStorage` (see
 * next/dist/server/app-render/async-local-storage.js); if it's unset when that
 * module first loads, Next falls back to a FakeAsyncLocalStorage that throws
 * "Invariant: AsyncLocalStorage accessed in runtime where it is not available"
 * (E504) at server startup. In `next start` Next's own node-environment sets it
 * early, but a CUSTOM server (our `server.ts`, launched via tsx) can load Next's
 * internals before that bootstrap — reproduced on Node 24.11.1 + Next 16 + tsx,
 * where the production start crashed before binding a port.
 *
 * MUST be imported as the FIRST side-effect in server.ts (before `import next`).
 * Idempotent + harmless: it only fills the global when absent, so it can't shadow
 * a value Next (or the runtime) would otherwise provide.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const g = globalThis as typeof globalThis & { AsyncLocalStorage?: unknown };
if (!g.AsyncLocalStorage) {
  g.AsyncLocalStorage = AsyncLocalStorage;
}
