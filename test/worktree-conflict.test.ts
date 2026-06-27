/**
 * Worktree-conflict detector — the pure core. Locks: two+ sessions sharing a
 * normalized working_directory are flagged with their group size; a unique
 * checkout (every worktree session, any lone session) is never flagged; the "~"
 * / empty default dirs are exempt; separator + trailing-slash differences merge.
 */
import { describe, it, expect } from "vitest";
import {
  detectSharedCheckouts,
  normalizeCheckout,
} from "../lib/worktree-conflict";

const s = (id: string, dir: string) => ({ id, working_directory: dir });

describe("normalizeCheckout", () => {
  it("unifies separators and strips a trailing slash, without lowercasing", () => {
    expect(normalizeCheckout("C:\\repo\\app\\")).toBe("C:/repo/app");
    expect(normalizeCheckout("/home/me/repo/")).toBe("/home/me/repo");
    expect(normalizeCheckout("/home/Me/Repo")).toBe("/home/Me/Repo"); // case kept
  });
});

describe("detectSharedCheckouts", () => {
  it("flags two sessions sharing a checkout with the group size", () => {
    const out = detectSharedCheckouts([
      s("a", "/repo/app"),
      s("b", "/repo/app"),
    ]);
    expect(out).toEqual({ a: 2, b: 2 });
  });

  it("counts the full group (3 sessions → 3)", () => {
    const out = detectSharedCheckouts([
      s("a", "/repo/app"),
      s("b", "/repo/app"),
      s("c", "/repo/app"),
    ]);
    expect(out).toEqual({ a: 3, b: 3, c: 3 });
  });

  it("does NOT flag a unique checkout (worktree-isolated sessions self-exempt)", () => {
    const out = detectSharedCheckouts([
      s("a", "/repo/.worktrees/wt-1"),
      s("b", "/repo/.worktrees/wt-2"),
      s("c", "/repo/app"),
    ]);
    expect(out).toEqual({});
  });

  it("exempts the non-specific '~' / empty default dirs", () => {
    const out = detectSharedCheckouts([
      s("a", "~"),
      s("b", "~"),
      s("c", ""),
      s("d", "~/"),
    ]);
    expect(out).toEqual({});
  });

  it("merges trailing-slash and separator differences into one group", () => {
    const out = detectSharedCheckouts([
      s("a", "/repo/app"),
      s("b", "/repo/app/"),
      s("c", "/repo/app"),
    ]);
    expect(out).toEqual({ a: 3, b: 3, c: 3 });
  });

  it("flags only the colliding group, leaving lone + exempt sessions alone", () => {
    const out = detectSharedCheckouts([
      s("a", "/repo/x"),
      s("b", "/repo/x"), // share x → flagged
      s("c", "/repo/y"), // lone → not flagged
      s("d", "~"), // exempt
      s("e", "~"), // exempt
    ]);
    expect(out).toEqual({ a: 2, b: 2 });
  });

  it("returns an empty map for a single session or an empty list", () => {
    expect(detectSharedCheckouts([])).toEqual({});
    expect(detectSharedCheckouts([s("a", "/repo/app")])).toEqual({});
  });

  it("excludes DEAD sessions from the count (a dead pty can't clobber)", () => {
    const sessions = [
      s("live1", "/repo/app"),
      s("live2", "/repo/app"),
      s("dead1", "/repo/app"), // shares the dir but its pty is gone
    ];
    const live = new Set(["live1", "live2"]);
    const out = detectSharedCheckouts(sessions, {
      isLive: (id) => live.has(id),
    });
    // Only the two live sessions are a real conflict — group size 2, dead absent.
    expect(out).toEqual({ live1: 2, live2: 2 });
  });

  it("drops a now-lone live session once its co-occupant is dead", () => {
    const sessions = [s("live", "/repo/app"), s("dead", "/repo/app")];
    const out = detectSharedCheckouts(sessions, {
      isLive: (id) => id === "live",
    });
    expect(out).toEqual({}); // one live session in the dir → no conflict
  });

  it("expands a leading '~' against homeDir so it merges with the absolute form", () => {
    const out = detectSharedCheckouts(
      [s("a", "~/projects/foo"), s("b", "/home/me/projects/foo")],
      { homeDir: "/home/me" }
    );
    expect(out).toEqual({ a: 2, b: 2 }); // same checkout, different spelling
  });

  it("exempts bare $HOME in its EXPANDED form (not a checkout to isolate)", () => {
    const out = detectSharedCheckouts(
      [s("a", "/home/me"), s("b", "/home/me"), s("c", "~")],
      { homeDir: "/home/me" }
    );
    expect(out).toEqual({}); // all resolve to $HOME → exempt
  });

  it("compares case-insensitively when caseInsensitive (Windows)", () => {
    const sessions = [s("a", "C:\\Repo\\App"), s("b", "c:\\repo\\app")];
    // Case-sensitive (POSIX): distinct → no conflict.
    expect(detectSharedCheckouts(sessions)).toEqual({});
    // Case-insensitive (Windows): same checkout → flagged.
    expect(detectSharedCheckouts(sessions, { caseInsensitive: true })).toEqual({
      a: 2,
      b: 2,
    });
  });
});
