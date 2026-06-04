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

  if (existsSync(VAPID_PATH)) {
    // The file is the source of truth. Distinguish a transient READ failure
    // (Windows file lock / AV scan / partial write) from genuine corruption: a
    // read error must NOT regenerate, because overwriting a still-valid file
    // would invalidate every existing push subscription. Only a parsed-but-bad
    // file falls through to regenerate.
    let raw: string;
    try {
      raw = readFileSync(VAPID_PATH, "utf-8");
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    try {
      const parsed = JSON.parse(raw) as Partial<VapidKeys>;
      if (parsed.publicKey && parsed.privateKey) {
        cached = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
        return cached;
      }
    } catch {
      // Corrupt JSON — fall through to regenerate (it's unparseable anyway).
    }
  }

  const keys = webpush.generateVAPIDKeys();
  cached = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  try {
    mkdirSync(path.dirname(VAPID_PATH), { recursive: true });
    // Best-effort owner-only perms on POSIX. NOTE: ignored on Windows (NTFS uses
    // ACLs, not POSIX mode bits) — the key inherits the ~/.stoa dir ACL there,
    // so this isn't a hard guarantee on a shared Windows host.
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
          data,
          // Per-send idle timeout (web-push maps this to the socket inactivity
          // timeout, not an absolute deadline) so a dead/silent push endpoint
          // doesn't hang forever. The status ticker fires these without awaiting
          // them, so a slow send can't stall the live WS broadcast.
          { timeout: 10000 }
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
