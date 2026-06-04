/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { defaultCache } from "@serwist/turbopack/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";
import { shouldSuppressPush } from "@/lib/push-visibility";

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
// The server pushes to EVERY device; we dedupe per-device here — if a Stoa tab
// is actively visible on THIS device the in-app path already alerts, so skip
// the push (other devices, e.g. a phone with the tab closed, still get it).
self.addEventListener("push", (event) => {
  let payload: { title?: string; body?: string; tag?: string; url?: string } =
    {};
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
        data: { url: payload.url || "/" },
      });
    })()
  );
});

// Focus an existing Stoa window (or open one) when a push notification is tapped.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
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
    })()
  );
});
