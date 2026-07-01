"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  decideSelfHeal,
  readPushIntent,
  readPushIntentState,
  writePushIntent,
  RESYNC_MIN_INTERVAL_MS,
} from "@/lib/push-selfheal";

// VAPID public key (base64url) → Uint8Array for PushManager.subscribe.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/** Store a subscription server-side (idempotent upsert). Throws on a non-2xx
 *  response — fetch doesn't reject on HTTP errors, and a heal that mistakes a
 *  5xx for success would throttle itself into staying broken. */
async function postSubscription(sub: PushSubscription): Promise<void> {
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub),
  });
  if (!res.ok) throw new Error(`push subscribe POST failed: ${res.status}`);
}

/**
 * Web Push (closed-tab notifications) subscription state + actions. Subscribes
 * via the service worker's PushManager using the server's VAPID key and stores
 * the subscription server-side; the server then pushes status transitions even
 * when no tab is open. Requires a secure context (https/localhost) + the SW.
 *
 * SELF-HEALING (#16): iOS silently drops a PWA's push subscription, so on mount
 * and whenever the app regains visibility this re-checks reality against the
 * user's recorded opt-in intent — silently re-subscribing when the subscription
 * vanished (permission still granted), or re-POSTing the live subscription
 * (throttled) so a server-side prune can't leave the client believing it's
 * subscribed. Decision logic is pure in lib/push-selfheal.ts. An explicit
 * opt-out STICKS: intent is tri-state ("out" is written, never removed, so the
 * backfill can't mistake it for never-set), unsubscribe serializes behind any
 * in-flight heal, and a heal re-checks intent after subscribing and rolls the
 * fresh subscription back if the user opted out mid-flight.
 */
export function useWebPush() {
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  // The in-flight heal (null when idle): dedupes visibility bursts AND lets
  // unsubscribe await it, so opt-out always runs AFTER any heal it raced.
  const healingRef = useRef<Promise<void> | null>(null);
  // Resync at most once per RESYNC_MIN_INTERVAL_MS — marked only on SUCCESS so
  // a failed resync retries on the next focus instead of throttling itself.
  const lastResyncRef = useRef(0);

  /** The full subscribe flow (VAPID key → pushManager.subscribe → server POST).
   *  Shared by the user-initiated action and the silent self-heal. */
  const doSubscribe = useCallback(async (): Promise<boolean> => {
    const reg = await navigator.serviceWorker.ready;
    const res = await fetch("/api/push/key");
    if (!res.ok) return false;
    const { publicKey } = await res.json();
    if (!publicKey) return false;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // Cast: lib.dom types Uint8Array as Uint8Array<ArrayBufferLike>, but
      // applicationServerKey wants BufferSource (ArrayBuffer-backed) — same bytes.
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
    await postSubscription(sub);
    return true;
  }, []);

  useEffect(() => {
    const ok =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window;
    setSupported(ok);
    if (!ok) return;

    // Reflect current reality, then self-heal it against the recorded intent —
    // on launch and every time the app becomes visible again (the moment iOS
    // hands back a PWA whose subscription it silently dropped).
    const heal = (): Promise<void> => {
      if (healingRef.current) return healingRef.current;
      const run = (async () => {
        try {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          setSubscribed(!!sub);
          // Backfill: subscribers from before the intent flag existed have a
          // live subscription but a NEVER-SET flag — a live subscription is
          // proof of a past opt-in, so record it (otherwise self-heal never
          // arms for them). Strictly "unset": an explicit opt-out reads "out"
          // and is never resurrected here.
          if (sub && readPushIntentState() === "unset") writePushIntent(true);
          const action = decideSelfHeal({
            supported: true,
            intent: readPushIntent(),
            permission:
              typeof Notification !== "undefined"
                ? Notification.permission
                : "unsupported",
            hasSubscription: !!sub,
            resyncedRecently:
              Date.now() - lastResyncRef.current < RESYNC_MIN_INTERVAL_MS,
          });
          if (action === "resubscribe") {
            // Permission is already granted, so this needs no user gesture.
            // Deliberately does NOT set `busy`: a background heal shouldn't
            // flicker the settings toggle, and a user subscribe racing this is
            // harmless — pushManager.subscribe returns the same subscription
            // and the server POST is an idempotent upsert.
            const ok2 = await doSubscribe();
            if (ok2 && !readPushIntent()) {
              // The user opted out while the subscribe was in flight — roll the
              // fresh subscription back so the opt-out sticks.
              const zombie = await reg.pushManager.getSubscription();
              if (zombie) {
                await fetch("/api/push/unsubscribe", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ endpoint: zombie.endpoint }),
                }).catch(() => {});
                await zombie.unsubscribe().catch(() => {});
              }
              setSubscribed(false);
            } else if (ok2) {
              setSubscribed(true);
            }
          } else if (action === "resync" && sub) {
            // Idempotent upsert — repairs a server that pruned/lost the
            // endpoint while the client still holds a valid subscription.
            // Throws on failure (see postSubscription) so the throttle below
            // is only recorded for a resync that actually landed.
            await postSubscription(sub);
            lastResyncRef.current = Date.now();
          }
        } catch {
          // Best-effort: a failed heal changes nothing and retries on next focus.
        } finally {
          healingRef.current = null;
        }
      })();
      healingRef.current = run;
      return run;
    };

    void heal();
    const onVisible = () => {
      if (document.visibilityState === "visible") void heal();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [doSubscribe]);

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!supported) return false;
    setBusy(true);
    try {
      const ok = await doSubscribe();
      if (ok) {
        writePushIntent(true); // remember the opt-in so self-heal may act (#16)
        setSubscribed(true);
      }
      return ok;
    } catch (err) {
      console.error("web push subscribe failed:", err);
      return false;
    } finally {
      setBusy(false);
    }
  }, [supported, doSubscribe]);

  const unsubscribe = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      // Opt out FIRST (tri-state "out" — the backfill can never mistake it for
      // never-set), then wait out any in-flight heal so whatever it may have
      // just created is what we delete below. Order guarantees the opt-out
      // always wins the race.
      writePushIntent(false);
      if (healingRef.current) await healingRef.current.catch(() => {});
      if (!("serviceWorker" in navigator)) {
        setSubscribed(false);
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // Best-effort server delete (deliberately no res.ok check): if it
        // fails, the orphaned endpoint 404/410s on the next send and the
        // server prunes it — the browser-side unsubscribe below is what stops
        // the notifications.
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch (err) {
      console.error("web push unsubscribe failed:", err);
    } finally {
      setBusy(false);
    }
  }, []);

  // Fire a diagnostic test notification to this device's subscription(s) so the
  // user can confirm on demand exactly how a toast renders (text + buttons).
  const sendTest = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      return res.ok;
    } catch (err) {
      console.error("web push test failed:", err);
      return false;
    }
  }, []);

  return { supported, subscribed, busy, subscribe, unsubscribe, sendTest };
}
