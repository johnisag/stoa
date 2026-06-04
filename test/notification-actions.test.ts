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

describe("isRespondAction", () => {
  it("accepts only the known actions", () => {
    for (const a of RESPOND_ACTIONS) expect(isRespondAction(a)).toBe(true);
    expect(isRespondAction("approve")).toBe(true);
    expect(isRespondAction("reject")).toBe(true);
    expect(isRespondAction("stop")).toBe(true);
  });
  it("rejects anything else (incl. non-strings)", () => {
    expect(isRespondAction("kill")).toBe(false); // it's "stop", not "kill"
    expect(isRespondAction("")).toBe(false);
    expect(isRespondAction(undefined)).toBe(false);
    expect(isRespondAction(null)).toBe(false);
    expect(isRespondAction(42)).toBe(false);
    expect(isRespondAction({ action: "approve" })).toBe(false);
  });
});

describe("actionsForKind", () => {
  it("a waiting session offers approve / reject / stop", () => {
    expect(actionsForKind("waiting").map((a) => a.action)).toEqual([
      "approve",
      "reject",
      "stop",
    ]);
  });
  it("an errored session only offers stop", () => {
    expect(actionsForKind("error").map((a) => a.action)).toEqual(["stop"]);
  });
  it("a done session has no actions", () => {
    expect(actionsForKind("done")).toEqual([]);
  });
  it("every button has a non-empty title", () => {
    for (const a of actionsForKind("waiting")) {
      expect(a.title.length).toBeGreaterThan(0);
      expect(isRespondAction(a.action)).toBe(true);
    }
  });
});

describe("cardActionsForStatus", () => {
  it("a waiting session offers the full decision", () => {
    expect(cardActionsForStatus("waiting")).toEqual([
      "approve",
      "reject",
      "stop",
    ]);
  });
  it("running and error sessions only offer stop", () => {
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
  it("maps each action to its terminal op", () => {
    expect(planResponse("approve")).toBe("enter");
    expect(planResponse("reject")).toBe("escape");
    expect(planResponse("stop")).toBe("kill");
  });
});

describe("applyResponse", () => {
  // A spy backend records which op fired + the name it got — locks the dispatch
  // (a swapped Enter/Escape or a mis-wired kill fails here, not silently).
  function spy() {
    const calls: Array<[string, string]> = [];
    const target: ResponseTarget = {
      sendEnter: async (n) => void calls.push(["enter", n]),
      sendEscape: async (n) => void calls.push(["escape", n]),
      kill: async (n) => void calls.push(["kill", n]),
    };
    return { calls, target };
  }

  it("routes each action to the matching backend op, with the name", async () => {
    const { calls, target } = spy();
    await applyResponse(target, "claude-a", "approve");
    await applyResponse(target, "claude-b", "reject");
    await applyResponse(target, "claude-c", "stop");
    expect(calls).toEqual([
      ["enter", "claude-a"],
      ["escape", "claude-b"],
      ["kill", "claude-c"],
    ]);
  });

  it("calls exactly one op per action", async () => {
    const { calls, target } = spy();
    await applyResponse(target, "s", "approve");
    expect(calls).toHaveLength(1);
  });
});
