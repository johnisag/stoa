"use client";

import { useState, useEffect, useCallback } from "react";

// VAPID public key (base64url) → Uint8Array for PushManager.subscribe.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/**
 * Web Push (closed-tab notifications) subscription state + actions. Subscribes
 * via the service worker's PushManager using the server's VAPID key and stores
 * the subscription server-side; the server then pushes status transitions even
 * when no tab is open. Requires a secure context (https/localhost) + the SW.
 */
export function useWebPush() {
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ok =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window;
    setSupported(ok);
    if (!ok) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(!!sub))
      .catch(() => {});
  }, []);

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!supported) return false;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const res = await fetch("/api/push/key");
      const { publicKey } = await res.json();
      if (!publicKey) return false;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // Cast: lib.dom types Uint8Array as Uint8Array<ArrayBufferLike>, but
        // applicationServerKey wants BufferSource (ArrayBuffer-backed) — same bytes.
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub),
      });
      setSubscribed(true);
      return true;
    } catch (err) {
      console.error("web push subscribe failed:", err);
      return false;
    } finally {
      setBusy(false);
    }
  }, [supported]);

  const unsubscribe = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
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

  return { supported, subscribed, busy, subscribe, unsubscribe };
}
