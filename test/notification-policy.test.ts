/**
 * #52 notification policy — the PURE decision core for closed-tab Web Push
 * DISPLAY: quiet-hours (with midnight wrap), per-session mute precedence, the
 * stable grouping tag, and silent-vs-loud + renotify classification. All pure,
 * so it runs identically on every OS with no DOM/SW.
 */
import { describe, it, expect } from "vitest";
import {
  isQuietTime,
  notificationTag,
  shouldRenotify,
  isSilentKind,
  decideNotify,
  minutesOfDay,
  toggleMuted,
  parseHhMm,
  formatHhMm,
  defaultQuietHours,
  defaultNotificationPolicy,
  type QuietHours,
  type NotificationPolicy,
} from "@/lib/notification-policy";
import { coercePolicy } from "@/lib/notification-policy-idb";

const HM = (h: number, m = 0) => h * 60 + m;

describe("isQuietTime — quiet hours with midnight wrap", () => {
  it("is never quiet when disabled (default OFF)", () => {
    expect(defaultQuietHours.enabled).toBe(false);
    expect(isQuietTime(HM(23, 30), defaultQuietHours)).toBe(false);
    // Even at a time inside the default window, disabled ⇒ not quiet.
    expect(isQuietTime(HM(2), { ...defaultQuietHours, enabled: false })).toBe(
      false
    );
  });

  it("same-day window (01:00→06:00): inside is quiet, outside is loud", () => {
    const q: QuietHours = { enabled: true, startMin: HM(1), endMin: HM(6) };
    expect(isQuietTime(HM(0, 59), q)).toBe(false); // just before start
    expect(isQuietTime(HM(1), q)).toBe(true); // at start (inclusive)
    expect(isQuietTime(HM(3, 30), q)).toBe(true); // middle
    expect(isQuietTime(HM(5, 59), q)).toBe(true); // just before end
    expect(isQuietTime(HM(6), q)).toBe(false); // at end (exclusive)
    expect(isQuietTime(HM(12), q)).toBe(false); // midday
  });

  it("WRAPS midnight (22:00→07:00): late night AND early morning are quiet", () => {
    const q: QuietHours = { enabled: true, startMin: HM(22), endMin: HM(7) };
    expect(isQuietTime(HM(21, 59), q)).toBe(false); // just before start
    expect(isQuietTime(HM(22), q)).toBe(true); // at start
    expect(isQuietTime(HM(23, 30), q)).toBe(true); // before midnight
    expect(isQuietTime(HM(0), q)).toBe(true); // midnight
    expect(isQuietTime(HM(3), q)).toBe(true); // small hours
    expect(isQuietTime(HM(6, 59), q)).toBe(true); // just before end
    expect(isQuietTime(HM(7), q)).toBe(false); // at end (exclusive — alarm fires)
    expect(isQuietTime(HM(12), q)).toBe(false); // midday is loud
  });

  it("start === end is an EMPTY window (no quiet hours), not all-day", () => {
    const q: QuietHours = { enabled: true, startMin: HM(9), endMin: HM(9) };
    expect(isQuietTime(HM(9), q)).toBe(false);
    expect(isQuietTime(HM(3), q)).toBe(false);
    expect(isQuietTime(HM(21), q)).toBe(false);
  });

  it("rejects malformed minutes (out of range / non-finite) as not-quiet", () => {
    const q: QuietHours = { enabled: true, startMin: HM(22), endMin: HM(7) };
    expect(isQuietTime(-1, q)).toBe(false);
    expect(isQuietTime(1440, q)).toBe(false);
    expect(isQuietTime(NaN, q)).toBe(false);
    expect(
      isQuietTime(HM(23), { enabled: true, startMin: NaN, endMin: HM(7) })
    ).toBe(false);
  });
});

describe("notificationTag — stable per-session grouping", () => {
  it("is stable for a given session id (newer replaces older)", () => {
    expect(notificationTag("abc")).toBe(notificationTag("abc"));
  });

  it("differs between sessions (no cross-session collapse)", () => {
    expect(notificationTag("abc")).not.toBe(notificationTag("xyz"));
  });

  it("is namespaced so it can't collide with the diagnostic test tag", () => {
    expect(notificationTag("abc")).not.toBe("stoa-test");
    expect(notificationTag("abc").startsWith("stoa-session-")).toBe(true);
  });

  it("groups needs-you kinds (waiting/error) under the SAME tag", () => {
    // A newer prompt replaces the older needs-you banner — the grouping win.
    expect(notificationTag("abc", "waiting")).toBe(notificationTag("abc"));
    expect(notificationTag("abc", "error")).toBe(
      notificationTag("abc", "waiting")
    );
  });

  it("gives 'done' its OWN tag so a silent completion can't replace a needs-you banner", () => {
    // The blocker regression: a done sharing the session tag would silently
    // dismiss an unanswered waiting/error banner.
    expect(notificationTag("abc", "done")).not.toBe(
      notificationTag("abc", "waiting")
    );
    expect(notificationTag("abc", "done")).toBe("stoa-session-abc-done");
    // done still groups among done's for the same session.
    expect(notificationTag("abc", "done")).toBe(notificationTag("abc", "done"));
  });
});

describe("silent-vs-loud + renotify classification", () => {
  it("only needs-you kinds (waiting/error) renotify; done is quiet on replace", () => {
    expect(shouldRenotify("waiting")).toBe(true);
    expect(shouldRenotify("error")).toBe(true);
    expect(shouldRenotify("done")).toBe(false);
  });

  it("completions are SILENT; needs-you kinds are loud", () => {
    expect(isSilentKind("done")).toBe(true);
    expect(isSilentKind("waiting")).toBe(false);
    expect(isSilentKind("error")).toBe(false);
  });
});

describe("decideNotify — the full DISPLAY decision + precedence", () => {
  const base: NotificationPolicy = {
    quietHours: { enabled: false, startMin: HM(22), endMin: HM(7) },
    mutedSessionIds: [],
  };

  it("shows a needs-you push loud with renotify when nothing gates it", () => {
    expect(
      decideNotify({
        kind: "waiting",
        sessionId: "s1",
        nowMin: HM(12),
        policy: base,
      })
    ).toEqual({ show: true, silent: false, renotify: true });
  });

  it("shows a completion SILENT (no renotify) when nothing gates it", () => {
    expect(
      decideNotify({
        kind: "done",
        sessionId: "s1",
        nowMin: HM(12),
        policy: base,
      })
    ).toEqual({ show: true, silent: true, renotify: false });
  });

  it("MUTE suppresses entirely — even a needs-you push, even outside quiet hours", () => {
    const policy: NotificationPolicy = { ...base, mutedSessionIds: ["s1"] };
    const d = decideNotify({
      kind: "waiting",
      sessionId: "s1",
      nowMin: HM(12),
      policy,
    });
    expect(d.show).toBe(false);
  });

  it("a non-muted session is unaffected by another session's mute", () => {
    const policy: NotificationPolicy = { ...base, mutedSessionIds: ["other"] };
    expect(
      decideNotify({ kind: "waiting", sessionId: "s1", nowMin: HM(12), policy })
        .show
    ).toBe(true);
  });

  it("QUIET HOURS suppress the push during the window", () => {
    const policy: NotificationPolicy = {
      ...base,
      quietHours: { enabled: true, startMin: HM(22), endMin: HM(7) },
    };
    // 23:30 is inside the window → suppressed.
    expect(
      decideNotify({
        kind: "waiting",
        sessionId: "s1",
        nowMin: HM(23, 30),
        policy,
      }).show
    ).toBe(false);
    // 12:00 is outside → shown.
    expect(
      decideNotify({ kind: "waiting", sessionId: "s1", nowMin: HM(12), policy })
        .show
    ).toBe(true);
  });

  it("MUTE takes precedence over quiet hours (muted wins even when both apply)", () => {
    const policy: NotificationPolicy = {
      quietHours: { enabled: true, startMin: HM(22), endMin: HM(7) },
      mutedSessionIds: ["s1"],
    };
    // Both a muted session AND inside quiet hours → suppressed (mute checked first).
    expect(
      decideNotify({ kind: "waiting", sessionId: "s1", nowMin: HM(2), policy })
        .show
    ).toBe(false);
  });

  it("a TEST push always shows loud, bypassing mute AND quiet hours", () => {
    const policy: NotificationPolicy = {
      quietHours: { enabled: true, startMin: HM(0), endMin: HM(23, 59) },
      mutedSessionIds: ["s1"],
    };
    expect(
      decideNotify({
        kind: "done",
        sessionId: "s1",
        nowMin: HM(3),
        policy,
        isTest: true,
      })
    ).toEqual({ show: true, silent: false, renotify: false });
  });

  it("an unknown/absent kind is treated as loud (fail-loud)", () => {
    const d = decideNotify({
      kind: undefined,
      sessionId: "s1",
      nowMin: HM(12),
      policy: base,
    });
    expect(d).toEqual({ show: true, silent: false, renotify: true });
  });

  it("no sessionId ⇒ never matches a mute (still shows)", () => {
    const policy: NotificationPolicy = { ...base, mutedSessionIds: ["s1"] };
    expect(
      decideNotify({
        kind: "waiting",
        sessionId: undefined,
        nowMin: HM(12),
        policy,
      }).show
    ).toBe(true);
  });
});

describe("toggleMuted — immutable add/remove", () => {
  it("adds an id when absent (new array)", () => {
    const before = ["a"];
    const after = toggleMuted(before, "b");
    expect(after).toEqual(["a", "b"]);
    expect(before).toEqual(["a"]); // unchanged (immutable)
  });

  it("removes an id when present", () => {
    expect(toggleMuted(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("minutesOfDay / parseHhMm / formatHhMm", () => {
  it("minutesOfDay reads the local wall clock", () => {
    const d = new Date(2026, 6, 2, 22, 30, 0);
    expect(minutesOfDay(d)).toBe(HM(22, 30));
  });

  it("parseHhMm parses valid times and rejects garbage", () => {
    expect(parseHhMm("22:00")).toBe(HM(22));
    expect(parseHhMm("07:05")).toBe(HM(7, 5));
    expect(parseHhMm("0:00")).toBe(0);
    expect(parseHhMm("24:00")).toBeNull();
    expect(parseHhMm("12:60")).toBeNull();
    expect(parseHhMm("noon")).toBeNull();
    expect(parseHhMm("")).toBeNull();
  });

  it("formatHhMm round-trips with parseHhMm and zero-pads", () => {
    expect(formatHhMm(HM(7))).toBe("07:00");
    expect(formatHhMm(HM(22, 5))).toBe("22:05");
    expect(parseHhMm(formatHhMm(HM(13, 45)))).toBe(HM(13, 45));
    // Out-of-range input clamps to a safe 00:00 rather than emitting garbage.
    expect(formatHhMm(-5)).toBe("00:00");
    expect(formatHhMm(9999)).toBe("00:00");
  });
});

describe("defaults", () => {
  it("quiet hours default OFF; policy default has no mutes", () => {
    expect(defaultQuietHours.enabled).toBe(false);
    expect(defaultNotificationPolicy.mutedSessionIds).toEqual([]);
    expect(defaultNotificationPolicy.quietHours.enabled).toBe(false);
  });
});

describe("coercePolicy — hostile / legacy stored-blob guard (SW read path)", () => {
  it("returns the default policy for non-object inputs", () => {
    expect(coercePolicy(undefined)).toEqual(defaultNotificationPolicy);
    expect(coercePolicy(null)).toEqual(defaultNotificationPolicy);
    expect(coercePolicy("nope")).toEqual(defaultNotificationPolicy);
    expect(coercePolicy(42)).toEqual(defaultNotificationPolicy);
  });

  it("fills missing quietHours fields from the default", () => {
    const p = coercePolicy({ mutedSessionIds: ["a"] });
    expect(p.quietHours).toEqual(defaultNotificationPolicy.quietHours);
    expect(p.mutedSessionIds).toEqual(["a"]);
  });

  it("drops a non-array mutedSessionIds (can't reach .includes on a string)", () => {
    const p = coercePolicy({ mutedSessionIds: "s1" });
    expect(p.mutedSessionIds).toEqual([]);
  });

  it("filters non-string entries out of the mute list", () => {
    const p = coercePolicy({ mutedSessionIds: ["a", 5, null, "b", {}] });
    expect(p.mutedSessionIds).toEqual(["a", "b"]);
  });

  it("keeps a valid quietHours through unchanged", () => {
    const p = coercePolicy({
      quietHours: { enabled: true, startMin: 60, endMin: 120 },
      mutedSessionIds: [],
    });
    expect(p.quietHours).toEqual({ enabled: true, startMin: 60, endMin: 120 });
  });

  it("coerces a garbage quietHours.enabled to the default boolean", () => {
    const p = coercePolicy({
      quietHours: { enabled: "yes", startMin: "x", endMin: 120 },
    });
    expect(p.quietHours.enabled).toBe(
      defaultNotificationPolicy.quietHours.enabled
    );
    expect(p.quietHours.startMin).toBe(
      defaultNotificationPolicy.quietHours.startMin
    );
    expect(p.quietHours.endMin).toBe(120);
  });
});
