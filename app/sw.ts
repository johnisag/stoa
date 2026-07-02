/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { defaultCache } from "@serwist/turbopack/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";
import { shouldSuppressPush } from "@/lib/push-visibility";
import type { PushPayload } from "@/lib/push-types";
import { decideNotify, minutesOfDay } from "@/lib/notification-policy";
import { readPolicyFromIdb } from "@/lib/notification-policy-idb";

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
      // A diagnostic test push always shows (even with a tab open on this
      // device) — its whole purpose is to verify rendering on demand.
      if (!payload.test && shouldSuppressPush(windows)) return;
      // #52 per-device DISPLAY policy: quiet hours + per-session mute gate WHETHER
      // it shows; the kind decides silent-vs-loud + renotify. The client mirrors
      // the policy into IndexedDB (the SW can't read localStorage); a read failure
      // falls back to the default (loud) policy — never silently swallows a push.
      const policy = await readPolicyFromIdb();
      const decision = decideNotify({
        kind: payload.kind,
        sessionId: payload.sessionId,
        nowMin: minutesOfDay(new Date()),
        policy,
        isTest: payload.test,
      });
      if (!decision.show) return;
      await self.registration.showNotification(payload.title || "Stoa", {
        body: payload.body || "",
        // #52 grouping: a stable per-session tag makes the OS REPLACE this
        // session's older banner; renotify re-alerts only for needs-you kinds.
        tag: payload.tag,
        // `renotify` is only valid WITH a tag (the platform throws otherwise), so
        // guard on payload.tag even though every current sender provides one.
        renotify: decision.renotify && !!payload.tag,
        silent: decision.silent,
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

// Tapping the Stop action button routes back to the session via the respond
// endpoint; tapping the body (no action) focuses/opens the app. The
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
