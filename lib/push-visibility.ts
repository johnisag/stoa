/**
 * Per-device Web Push dedupe. The server fans a push out to EVERY subscription
 * (it can't know which device is watching), so the "don't double-notify while a
 * tab is open" decision has to live on each device — in the service worker,
 * which can see this browser's own windows.
 *
 * Suppress the push only when a Stoa tab is actively VISIBLE on this device: the
 * in-app Notification path already alerts there, and the live board shows the
 * change anyway. A closed, minimized, or backgrounded (hidden) tab still gets
 * the push — that's the whole point of closed-tab notifications, and it's why
 * the old server-side global gate was wrong (one open desktop tab silenced push
 * to the user's phone).
 *
 * Pure (no DOM/SW APIs) so it's unit-testable; the SW passes `clients.matchAll`
 * results straight in.
 */
export function shouldSuppressPush(
  clients: ReadonlyArray<{ visibilityState: string }>
): boolean {
  return clients.some((c) => c.visibilityState === "visible");
}
