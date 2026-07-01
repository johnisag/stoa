import { describe, it, expect } from "vitest";
import {
  decideSelfHeal,
  readPushIntent,
  readPushIntentState,
  writePushIntent,
  PUSH_INTENT_KEY,
  RESYNC_MIN_INTERVAL_MS,
  type SelfHealState,
} from "@/lib/push-selfheal";

const base: SelfHealState = {
  supported: true,
  intent: true,
  permission: "granted",
  hasSubscription: false,
  resyncedRecently: false,
};

describe("decideSelfHeal (#16 — the iOS dropped-subscription matrix)", () => {
  it("RESUBSCRIBES when intent + granted permission but the subscription vanished", () => {
    expect(decideSelfHeal(base)).toBe("resubscribe");
  });

  it("RESYNCS a live subscription (idempotent upsert repairs server-side drift)", () => {
    expect(decideSelfHeal({ ...base, hasSubscription: true })).toBe("resync");
  });

  it("throttles the resync (recently synced → none)", () => {
    expect(
      decideSelfHeal({ ...base, hasSubscription: true, resyncedRecently: true })
    ).toBe("none");
    // …but the throttle must NOT suppress a needed RESUBSCRIBE.
    expect(decideSelfHeal({ ...base, resyncedRecently: true })).toBe(
      "resubscribe"
    );
  });

  it("never heals without user intent (an explicit opt-out stays out)", () => {
    expect(decideSelfHeal({ ...base, intent: false })).toBe("none");
    expect(
      decideSelfHeal({ ...base, intent: false, hasSubscription: true })
    ).toBe("none");
  });

  it("never heals when permission is not granted (silent subscribe impossible)", () => {
    for (const permission of ["denied", "default", "unsupported"] as const) {
      expect(decideSelfHeal({ ...base, permission })).toBe("none");
    }
  });

  it("never heals when push is unsupported", () => {
    expect(decideSelfHeal({ ...base, supported: false })).toBe("none");
  });
});

describe("push intent storage helpers", () => {
  function fakeStorage(init: Record<string, string> = {}) {
    const data = new Map(Object.entries(init));
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
  }

  it("round-trips: write true → read true; write false → read false", () => {
    const s = fakeStorage();
    writePushIntent(true, s);
    expect(s.getItem(PUSH_INTENT_KEY)).toBe("1");
    expect(readPushIntent(s)).toBe(true);
    writePushIntent(false, s);
    expect(readPushIntent(s)).toBe(false);
  });

  it("an opt-out is TRI-STATE 'out' (written, not removed) — never mistaken for never-set", () => {
    const s = fakeStorage();
    writePushIntent(true, s);
    writePushIntent(false, s);
    // The key survives as an explicit "0": the backfill (which only acts on
    // "unset") can never resurrect this opt-out from a lingering subscription.
    expect(s.getItem(PUSH_INTENT_KEY)).toBe("0");
    expect(readPushIntentState(s)).toBe("out");
  });

  it("intent state: '1' → in, '0' → out, absent/unknown → unset", () => {
    expect(readPushIntentState(fakeStorage({ [PUSH_INTENT_KEY]: "1" }))).toBe(
      "in"
    );
    expect(readPushIntentState(fakeStorage({ [PUSH_INTENT_KEY]: "0" }))).toBe(
      "out"
    );
    expect(readPushIntentState(fakeStorage())).toBe("unset");
    expect(readPushIntentState(fakeStorage({ [PUSH_INTENT_KEY]: "yes" }))).toBe(
      "unset"
    );
  });

  it("reads false for absent or unexpected values", () => {
    expect(readPushIntent(fakeStorage())).toBe(false);
    expect(readPushIntent(fakeStorage({ [PUSH_INTENT_KEY]: "yes" }))).toBe(
      false
    );
  });

  it("fails CLOSED on storage errors (Safari private mode): read → false, write → no throw", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readPushIntent(throwing)).toBe(false);
    expect(readPushIntentState(throwing)).toBe("unset");
    expect(() => writePushIntent(true, throwing)).not.toThrow();
    expect(() => writePushIntent(false, throwing)).not.toThrow();
  });

  it("resync throttle window is a sane positive constant (minutes, not ms/hours)", () => {
    expect(RESYNC_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
    expect(RESYNC_MIN_INTERVAL_MS).toBeLessThanOrEqual(60 * 60_000);
  });
});
