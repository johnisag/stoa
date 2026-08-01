import { describe, expect, it } from "vitest";
import { hasFleetSchedulerIdentity } from "@/lib/fleet/scheduler-auth";

describe("hasFleetSchedulerIdentity", () => {
  it("fails closed and accepts only the configured scheduler token", () => {
    expect(hasFleetSchedulerIdentity(null, undefined)).toBe(false);
    expect(hasFleetSchedulerIdentity("operator", undefined)).toBe(false);
    expect(hasFleetSchedulerIdentity("operator", "scheduler")).toBe(false);
    expect(hasFleetSchedulerIdentity("scheduler", "scheduler")).toBe(true);
  });
});
