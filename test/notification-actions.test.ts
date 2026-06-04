import { describe, it, expect } from "vitest";
import {
  RESPOND_ACTIONS,
  isRespondAction,
  actionsForKind,
  planResponse,
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

describe("planResponse", () => {
  it("maps each action to its terminal op", () => {
    expect(planResponse("approve")).toBe("enter");
    expect(planResponse("reject")).toBe("escape");
    expect(planResponse("stop")).toBe("kill");
  });
});
