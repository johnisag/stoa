/**
 * The serialized Web Push payload shape — the wire contract between the server
 * (lib/push.ts sender) and the service worker (app/sw.ts receiver). Kept in its
 * own module with ZERO runtime imports so the SW can `import type` it without
 * pulling in lib/push.ts's node-only deps (web-push, fs, crypto). Both sides
 * referencing this one type means a field rename can't silently break action
 * routing — tsc flags the mismatch.
 */
export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  /** Session this push is about — routes notification actions back to it. */
  sessionId?: string;
  /** Lock-screen action buttons (approve/reject/stop); see lib/notification-actions. */
  actions?: Array<{ action: string; title: string }>;
}
