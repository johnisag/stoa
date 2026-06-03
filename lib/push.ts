import webpush from "web-push";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import { getDb, queries } from "./db";

/**
 * Web Push (closed-tab notifications). VAPID keypair is auto-generated and
 * persisted to ~/.stoa/vapid.json on first use (or read from STOA_VAPID_*),
 * subscriptions live in SQLite, and sendPushToAll pushes to every subscriber —
 * the server-side counterpart to the in-app Notification path, for when no tab
 * is open. All server-only (web-push needs node crypto).
 */

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const VAPID_PATH = path.join(os.homedir(), ".stoa", "vapid.json");
const VAPID_SUBJECT = process.env.STOA_VAPID_SUBJECT || "mailto:stoa@localhost";

let cached: VapidKeys | null = null;

export function getVapidKeys(): VapidKeys {
  if (cached) return cached;

  const envPub = process.env.STOA_VAPID_PUBLIC_KEY;
  const envPriv = process.env.STOA_VAPID_PRIVATE_KEY;
  if (envPub && envPriv) {
    cached = { publicKey: envPub, privateKey: envPriv };
    return cached;
  }

  try {
    if (existsSync(VAPID_PATH)) {
      const parsed = JSON.parse(
        readFileSync(VAPID_PATH, "utf-8")
      ) as Partial<VapidKeys>;
      if (parsed.publicKey && parsed.privateKey) {
        cached = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
        return cached;
      }
    }
  } catch {
    // fall through to regenerate
  }

  const keys = webpush.generateVAPIDKeys();
  cached = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  try {
    mkdirSync(path.dirname(VAPID_PATH), { recursive: true });
    // 0600 — the private key must not be world-readable on shared hosts.
    writeFileSync(VAPID_PATH, JSON.stringify(cached, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error("Failed to persist VAPID keys:", err);
  }
  return cached;
}

let vapidConfigured = false;
function ensureVapid(): void {
  if (vapidConfigured) return;
  const k = getVapidKeys();
  webpush.setVapidDetails(VAPID_SUBJECT, k.publicKey, k.privateKey);
  vapidConfigured = true;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function saveSubscription(sub: PushSubscriptionInput): void {
  queries
    .upsertPushSubscription(getDb())
    .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth);
}

export function deleteSubscription(endpoint: string): void {
  queries.deletePushSubscription(getDb()).run(endpoint);
}

export function hasPushSubscriptions(): boolean {
  try {
    const row = queries.countPushSubscriptions(getDb()).get() as {
      n: number;
    };
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

/** Send a notification to every stored subscription; prune expired ones. */
export async function sendPushToAll(payload: PushPayload): Promise<void> {
  ensureVapid();
  const subs = queries.getAllPushSubscriptions(getDb()).all() as Array<{
    endpoint: string;
    p256dh: string;
    auth: string;
  }>;
  if (subs.length === 0) return;
  const data = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          data
        );
      } catch (err: unknown) {
        const code = (err as { statusCode?: number })?.statusCode;
        // 404/410 = the push subscription is gone — prune it.
        if (code === 404 || code === 410) {
          deleteSubscription(s.endpoint);
        } else {
          console.error("web-push send failed:", code);
        }
      }
    })
  );
}
