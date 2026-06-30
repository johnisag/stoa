import { describe, it, expect } from "vitest";
import {
  RESPOND_ACTIONS,
  isRespondAction,
  actionsForKind,
  canApproveFromPrompt,
  cardActionsForStatus,
  respondErrorMessage,
  planResponse,
  applyResponse,
  type ResponseTarget,
} from "../lib/notification-actions";

// Notification actions: "stop" (always) + "approve" (#9 — one-tap Enter, offered ONLY for a
// safe press-Enter-to-continue / [Y/n] prompt (`continue`), NEVER for a permission menu's Yes
// (`affirmative` — a blind command grant) or blanket/negative/destructive/freeform). In-app
// cards stay Stop-only; the lock-screen push is where Approve appears.

describe("isRespondAction", () => {
  it("accepts the respond actions (stop, approve)", () => {
    for (const a of RESPOND_ACTIONS) expect(isRespondAction(a)).toBe(true);
    expect(RESPOND_ACTIONS).toEqual(["stop", "approve"]);
    expect(isRespondAction("stop")).toBe(true);
    expect(isRespondAction("approve")).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isRespondAction("reject")).toBe(false); // retired
    expect(isRespondAction("kill")).toBe(false); // it's "stop", not "kill"
    expect(isRespondAction("")).toBe(false);
    expect(isRespondAction(undefined)).toBe(false);
    expect(isRespondAction(null)).toBe(false);
    expect(isRespondAction(42)).toBe(false);
    expect(isRespondAction({ action: "stop" })).toBe(false);
  });
});

describe("actionsForKind", () => {
  it("a waiting session offers Stop; + Approve ONLY when the prompt is approvable", () => {
    expect(actionsForKind("waiting").map((a) => a.action)).toEqual(["stop"]);
    expect(
      actionsForKind("waiting", { canApprove: true }).map((a) => a.action)
    ).toEqual(["approve", "stop"]);
    expect(
      actionsForKind("waiting", { canApprove: false }).map((a) => a.action)
    ).toEqual(["stop"]);
  });
  it("an errored session offers Stop only (never Approve); a done session has none", () => {
    expect(actionsForKind("error").map((a) => a.action)).toEqual(["stop"]);
    expect(
      actionsForKind("error", { canApprove: true }).map((a) => a.action)
    ).toEqual(["stop"]);
    expect(actionsForKind("done")).toEqual([]);
  });
  it("every button has a non-empty title and is a valid respond action", () => {
    for (const a of actionsForKind("waiting", { canApprove: true })) {
      expect(a.title.length).toBeGreaterThan(0);
      expect(isRespondAction(a.action)).toBe(true);
    }
  });
});

describe("canApproveFromPrompt", () => {
  it("approvable ONLY for a press-Enter-to-continue / [Y/n] proceed prompt (continue)", () => {
    expect(canApproveFromPrompt("continue")).toBe(true);
  });
  it("NOT approvable for a permission MENU's Yes (affirmative — a blind command grant), nor any risky / free-text prompt, or none", () => {
    // affirmative IS Enter-safe for opt-in auto-answer, but a BLIND one-tap lock-screen grant
    // of an arbitrary command (denylist is fail-open) is not — fail closed, swap to the app.
    expect(canApproveFromPrompt("affirmative")).toBe(false);
    expect(canApproveFromPrompt("blanket")).toBe(false);
    expect(canApproveFromPrompt("negative")).toBe(false);
    expect(canApproveFromPrompt("destructive")).toBe(false);
    expect(canApproveFromPrompt("freeform")).toBe(false);
    expect(canApproveFromPrompt(null)).toBe(false);
    expect(canApproveFromPrompt(undefined)).toBe(false);
  });
});

describe("cardActionsForStatus", () => {
  it("a live session (waiting / running / error) offers Stop (in-app stays Stop-only)", () => {
    expect(cardActionsForStatus("waiting")).toEqual(["stop"]);
    expect(cardActionsForStatus("running")).toEqual(["stop"]);
    expect(cardActionsForStatus("error")).toEqual(["stop"]);
  });
  it("idle and dead sessions have no quick actions", () => {
    expect(cardActionsForStatus("idle")).toEqual([]);
    expect(cardActionsForStatus("dead")).toEqual([]);
  });
  it("only ever returns valid respond actions", () => {
    for (const status of [
      "waiting",
      "running",
      "error",
      "idle",
      "dead",
    ] as const)
      for (const a of cardActionsForStatus(status))
        expect(isRespondAction(a)).toBe(true);
  });
});

describe("respondErrorMessage", () => {
  it("treats 404/409 as benign — no error to show", () => {
    expect(respondErrorMessage(404)).toBeNull(); // session deleted
    expect(respondErrorMessage(409)).toBeNull(); // not running / double-tap / prompt changed
  });
  it("surfaces other failures with the status code", () => {
    expect(respondErrorMessage(500)).toBe("request failed (500)");
    expect(respondErrorMessage(401)).toBe("request failed (401)");
  });
});

describe("planResponse", () => {
  it("maps stop to kill and approve to enter", () => {
    expect(planResponse("stop")).toBe("kill");
    expect(planResponse("approve")).toBe("enter");
  });
});

describe("applyResponse", () => {
  // A spy backend records which op fired with which name.
  function spy() {
    const calls: Array<[string, string]> = [];
    const target: ResponseTarget = {
      kill: async (n) => void calls.push(["kill", n]),
      sendEnter: async (n) => void calls.push(["enter", n]),
    };
    return { calls, target };
  }

  it("routes stop to kill and approve to sendEnter, with the name", async () => {
    const { calls, target } = spy();
    await applyResponse(target, "claude-c", "stop");
    await applyResponse(target, "claude-c", "approve");
    expect(calls).toEqual([
      ["kill", "claude-c"],
      ["enter", "claude-c"],
    ]);
  });

  it("calls exactly one op per action", async () => {
    const { calls, target } = spy();
    await applyResponse(target, "s", "approve");
    expect(calls).toHaveLength(1);
  });
});
