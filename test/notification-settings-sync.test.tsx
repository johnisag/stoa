// @vitest-environment jsdom
/**
 * #52 round-2 regression: the Bell-menu settings (useNotifications) and the
 * per-session mute (useSessionMute) write the SAME localStorage key through
 * independent React state. A Bell-menu write must MERGE onto a fresh read so it
 * can't clobber a mute the user set from a SessionCard after this hook mounted.
 * (jsdom has no IndexedDB, so the IDB mirror no-ops; localStorage is the source
 * of truth we assert.)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNotifications } from "@/hooks/useNotifications";
import { loadSettings, saveSettings } from "@/lib/notifications";

describe("notification settings do not clobber a concurrent mute (#52)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("updateSettings preserves a mute written after the hook mounted", async () => {
    const { result } = renderHook(() => useNotifications());
    // Simulate the SessionCard mute hook writing a mute AFTER useNotifications
    // captured its (now stale) in-memory copy.
    await act(async () => {
      await saveSettings({ ...loadSettings(), mutedSessionIds: ["sess-1"] });
    });
    // The user opens the Bell menu and toggles quiet hours.
    act(() => {
      result.current.updateSettings({
        quietHours: { enabled: true, startMin: 1320, endMin: 420 },
      });
    });
    // The mute must SURVIVE (the old code spread stale prev → wiped it to []).
    expect(loadSettings().mutedSessionIds).toEqual(["sess-1"]);
    expect(loadSettings().quietHours.enabled).toBe(true);
  });

  it("toggleEvent preserves a concurrent mute too", async () => {
    const { result } = renderHook(() => useNotifications());
    await act(async () => {
      await saveSettings({ ...loadSettings(), mutedSessionIds: ["sess-2"] });
    });
    act(() => {
      result.current.toggleEvent("completed", true);
    });
    expect(loadSettings().mutedSessionIds).toEqual(["sess-2"]);
    expect(loadSettings().events.completed).toBe(true);
  });

  it("re-hydrates in-memory settings when another writer fires the change event", async () => {
    const { result } = renderHook(() => useNotifications());
    await act(async () => {
      await saveSettings({ ...loadSettings(), mutedSessionIds: ["sess-3"] });
    });
    // The listener re-read the shared key, so the hook's own state now reflects it.
    expect(result.current.settings.mutedSessionIds).toEqual(["sess-3"]);
  });
});
