/**
 * Web Push self-healing (#16) — the pure decision core.
 *
 * iOS silently invalidates a PWA's push subscription (a reinstall, an OS update,
 * or plain flakiness): `pushManager.getSubscription()` starts returning null while
 * the user still believes they're subscribed, so Stoa goes quiet forever. The fix:
 * remember the user's OPT-IN INTENT in localStorage, and on every app launch/focus
 * compare intent against reality —
 *
 *   - intent + permission granted + NO live subscription  → RESUBSCRIBE silently
 *     (no user gesture needed while permission is already granted);
 *   - intent + a live subscription                          → RESYNC (re-POST the
 *     subscription; a cheap idempotent upsert that repairs the OTHER drift
 *     direction — the server pruned/lost the endpoint while the client still
 *     holds a valid subscription), throttled so focus-spam doesn't hammer it;
 *   - no intent / permission revoked / unsupported          → do NOTHING (never
 *     resurrect a subscription the user turned off, and a silent re-subscribe is
 *     impossible without granted permission anyway).
 *
 * Kept pure + storage-injectable so the decision matrix is unit-tested without a
 * browser. The imperative shell lives in hooks/useWebPush.ts. Note the roadmap
 * phrased this as "when standalone"; gating on intent + granted permission is a
 * strict superset that also heals desktop browsers — an iOS Safari TAB (the case
 * standalone-gating would exclude) has no PushManager at all, so it never gets here.
 */

/** localStorage key remembering that the user explicitly enabled push. */
export const PUSH_INTENT_KEY = "stoa-push-intent";

/** Re-POST the live subscription at most this often (per running app). */
export const RESYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

export type SelfHealAction = "resubscribe" | "resync" | "none";

export interface SelfHealState {
  /** SW + PushManager available (secure context). */
  supported: boolean;
  /** The user previously opted in (readPushIntent). */
  intent: boolean;
  /** Notification.permission ("unsupported" when the API is absent). */
  permission: "granted" | "denied" | "default" | "unsupported";
  /** pushManager.getSubscription() returned a live subscription. */
  hasSubscription: boolean;
  /** A resync already ran within RESYNC_MIN_INTERVAL_MS (throttle). */
  resyncedRecently: boolean;
}

/** The single self-heal decision — pure → unit-tested as a matrix. */
export function decideSelfHeal(s: SelfHealState): SelfHealAction {
  if (!s.supported || !s.intent || s.permission !== "granted") return "none";
  if (!s.hasSubscription) return "resubscribe";
  return s.resyncedRecently ? "none" : "resync";
}

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

/**
 * The intent flag is TRI-STATE — that's load-bearing, not decoration:
 *   "in"    (key = "1")  the user opted in;
 *   "out"   (key = "0")  the user EXPLICITLY opted out — an opt-out is written,
 *                        never removed, so no later state can be mistaken for
 *                        "never set" and resurrect it (e.g. a live subscription
 *                        left behind by a failed browser unsubscribe);
 *   "unset" (absent)     the flag has never been written — a subscriber from
 *                        before the flag existed. ONLY this state may be
 *                        backfilled from a live subscription.
 * Unknown values and storage errors (Safari private mode) read as "unset" — that
 * heal then fails closed too, because the same failing storage rejects the
 * backfill WRITE and intent stays unreadable ("don't heal"). A later heal with
 * restored storage re-evaluates from scratch.
 */
export type PushIntentState = "in" | "out" | "unset";

function intentStorage<S>(storage: S | undefined): S | Storage | null {
  if (storage) return storage;
  return typeof window === "undefined" ? null : window.localStorage;
}

export function readPushIntentState(
  storage?: ReadableStorage
): PushIntentState {
  try {
    const s = intentStorage(storage);
    if (!s) return "unset";
    const v = s.getItem(PUSH_INTENT_KEY);
    return v === "1" ? "in" : v === "0" ? "out" : "unset";
  } catch {
    return "unset";
  }
}

/** Whether the user previously enabled push (intent state "in"). False on any
 *  storage error — failing closed means "don't heal". */
export function readPushIntent(storage?: ReadableStorage): boolean {
  return readPushIntentState(storage) === "in";
}

/** Record the user's push choice. An opt-out writes "0" (it does NOT remove the
 *  key) so it can never be confused with the never-set state the backfill acts
 *  on. Best-effort — a storage error only costs future self-healing, never the
 *  subscribe/unsubscribe itself. */
export function writePushIntent(on: boolean, storage?: WritableStorage): void {
  try {
    const s = intentStorage(storage);
    if (!s) return;
    s.setItem(PUSH_INTENT_KEY, on ? "1" : "0");
  } catch {
    // ignore
  }
}
