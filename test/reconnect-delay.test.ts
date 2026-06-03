import { describe, it, expect } from "vitest";
import { reconnectBaseDelay } from "../data/statuses/reconnect-delay";

describe("reconnectBaseDelay — /ws/events backoff ceiling (F14)", () => {
  it("grows exponentially from 1s", () => {
    expect(reconnectBaseDelay(0)).toBe(1000);
    expect(reconnectBaseDelay(1)).toBe(2000);
    expect(reconnectBaseDelay(2)).toBe(4000);
    expect(reconnectBaseDelay(3)).toBe(8000);
  });

  it("caps at 30s so a long outage doesn't widen unbounded", () => {
    expect(reconnectBaseDelay(5)).toBe(30000); // 32s clamped
    expect(reconnectBaseDelay(10)).toBe(30000);
    expect(reconnectBaseDelay(100)).toBe(30000);
  });
});
