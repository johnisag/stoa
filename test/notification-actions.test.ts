import { describe, it, expect } from "vitest";
import {
  RESPOND_ACTIONS,
  isRespondAction,
  actionsForKind,
  cardActionsForStatus,
  respondErrorMessage,
  planResponse,
  applyResponse,
  type ResponseTarget,
} from "../lib/notification-actions";

// Attention-only: the only respond action is "stop" (the approve/reject keystroke
// buttons were removed — you swap to the session and type). hasPrompt still drives
// the "ready vs needs input" notification copy + auto-steer, but no longer buttons.

describe("isRespondAction", () => {
  it("accepts only 'stop'", () => {
    for (const a of RESPOND_ACTIONS) expect(isRespondAction(a)).toBe(true);
    expect(RESPOND_ACTIONS).toEqual(["stop"]);
    expect(isRespondAction("stop")).toBe(true);
  });
  it("rejects the retired actions and anything else", () => {
    expect(isRespondAction("approve")).toBe(false); // retired
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
  it("a live session (waiting / error) offers a one-tap Stop", () => {
    expect(actionsForKind("waiting").map((a) => a.action)).toEqual(["stop"]);
    expect(actionsForKind("error").map((a) => a.action)).toEqual(["stop"]);
  });
  it("a done session has no actions", () => {
    expect(actionsForKind("done")).toEqual([]);
  });
  it("every button has a non-empty title and is a valid respond action", () => {
    for (const a of actionsForKind("waiting")) {
      expect(a.title.length).toBeGreaterThan(0);
      expect(isRespondAction(a.action)).toBe(true);
    }
  });
});

describe("cardActionsForStatus", () => {
  it("a live session (waiting / running / error) offers Stop", () => {
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
    expect(respondErrorMessage(409)).toBeNull(); // not running / double-tap
  });
  it("surfaces other failures with the status code", () => {
    expect(respondErrorMessage(500)).toBe("request failed (500)");
    expect(respondErrorMessage(401)).toBe("request failed (401)");
  });
});

describe("planResponse", () => {
  it("maps stop to kill", () => {
    expect(planResponse("stop")).toBe("kill");
  });
});

describe("applyResponse", () => {
  // A spy backend records that kill fired with the right name.
  function spy() {
    const calls: Array<[string, string]> = [];
    const target: ResponseTarget = {
      kill: async (n) => void calls.push(["kill", n]),
    };
    return { calls, target };
  }

  it("routes stop to the backend kill, with the name", async () => {
    const { calls, target } = spy();
    await applyResponse(target, "claude-c", "stop");
    expect(calls).toEqual([["kill", "claude-c"]]);
  });

  it("calls exactly one op per action", async () => {
    const { calls, target } = spy();
    await applyResponse(target, "s", "stop");
    expect(calls).toHaveLength(1);
  });
});
