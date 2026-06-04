/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { defaultCache } from "@serwist/turbopack/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";
import { shouldSuppressPush } from "@/lib/push-visibility";
import type { PushPayload } from "@/lib/push-types";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
});

serwist.addEventListeners();

// ── Web Push ──
// Show a notification when the server pushes a session event (fires even with
// the Stoa tab closed). Payload is the JSON from lib/push.sendPushToAll.
// The server pushes to EVERY device; we dedupe per-device here — if any Stoa
// window is open on THIS device the in-app path owns the alert, so skip the
// push (other devices, e.g. a phone with the tab closed, still get it).
// The receiver sees a partial of the wire contract (malformed/empty pushes → {}).
self.addEventListener("push", (event) => {
  let payload: Partial<PushPayload> = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { body: event.data.text() };
    }
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      if (shouldSuppressPush(windows)) return;
      await self.registration.showNotification(payload.title || "Stoa", {
        body: payload.body || "",
        tag: payload.tag,
        icon: "/icon.svg",
        actions: payload.actions ?? [],
        // sessionId rides along so notificationclick can route the action back.
        data: { url: payload.url || "/", sessionId: payload.sessionId },
      });
    })()
  );
});

// Focus an existing Stoa window, else open one.
async function focusOrOpen(url: string): Promise<void> {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows) {
    if ("focus" in client) {
      await client.focus();
      return;
    }
  }
  await self.clients.openWindow(url);
}

// Tapping an action button (approve/reject/stop) routes back to the session via
// the respond endpoint; tapping the body (no action) focuses/opens the app. The
// fetch is same-origin so the HttpOnly auth cookie rides along automatically. If
// the action can't be delivered (e.g. tapped too late → 409), fall back to
// opening the app so the tap isn't a silent no-op.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = (event.notification.data || {}) as {
    url?: string;
    sessionId?: string;
  };
  const url = data.url || "/";
  const action = event.action;

  if (action && data.sessionId) {
    event.waitUntil(
      fetch(`/api/sessions/${encodeURIComponent(data.sessionId)}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
        // Don't let a hung server hold the SW open — fall back to opening the app.
        signal: AbortSignal.timeout(10000),
      })
        .then((res) => (res.ok ? undefined : focusOrOpen(url)))
        .catch(() => focusOrOpen(url))
    );
    return;
  }

  event.waitUntil(focusOrOpen(url));
});
