/**
 * Per-device Web Push dedupe. The server fans a push out to EVERY subscription
 * (it can't know which device is watching), so the "don't double-notify while a
 * tab is open" decision has to live on each device — in the service worker,
 * which can see this browser's own windows.
 *
 * Suppress the push whenever ANY Stoa window is open on this device. The in-app
 * Notification path owns alerts whenever a tab is alive: it fires on blur and
 * stays quiet on focus (per the user's settings). Web Push is the CLOSED-TAB
 * fallback, so it fires only when no window exists here — which preserves the
 * multi-device win (a phone with the tab closed still gets pushed).
 *
 * NB: this used to key on `visibilityState === "visible"`, which double-notified
 * on a hidden/minimized tab — the SW saw "not visible" and pushed, while the
 * in-app path saw "not focused" and ALSO fired a Notification (mismatched gates).
 * "Any window open" matches the in-app focus partition: open tab → in-app owns
 * it; no tab → push.
 *
 * Pure (no DOM/SW APIs) so it's unit-testable; the SW passes `clients.matchAll`
 * results straight in.
 */
export function shouldSuppressPush(clients: ReadonlyArray<unknown>): boolean {
  return clients.length > 0;
}
