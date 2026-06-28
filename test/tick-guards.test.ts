/**
 * Cross-loop tick guards (cross-advancement review fix). Locks the mutual-exclusion
 * contract between the server.ts status-tick loops so a rate-limited or
 * being-written-to session is never double-pasted — the HIGH integration bug where
 * the prompt-queue loop pasted a queued prompt into a rate-limited TUI (which reads
 * as "idle") before its reset, defeating the rate-limit resume loop's gating.
 */
import { describe, it, expect } from "vitest";
import {
  queueDispatchBlocked,
  channelDeliveryBlocked,
} from "@/lib/tick-guards";

describe("queueDispatchBlocked", () => {
  it("REGRESSION: a rate-limited session blocks queued-prompt dispatch", () => {
    // The bug: a "limit reached" screen classifies as idle, so the queue loop would
    // paste the queued prompt before resetAt. The resume loop must own it instead.
    expect(
      queueDispatchBlocked({ rateLimited: true, channelInFlight: false })
    ).toBe(true);
  });

  it("blocks while a channel push is mid-paste (no interleaved double-write)", () => {
    expect(
      queueDispatchBlocked({ rateLimited: false, channelInFlight: true })
    ).toBe(true);
  });

  it("does NOT block a normal idle session", () => {
    expect(
      queueDispatchBlocked({ rateLimited: false, channelInFlight: false })
    ).toBe(false);
  });
});

describe("channelDeliveryBlocked", () => {
  const base = {
    rateLimited: false,
    rateLimitResumed: false,
    queueDispatched: false,
    channelInFlight: false,
  };

  it("does NOT block a clean idle session with an unread message", () => {
    expect(channelDeliveryBlocked(base)).toBe(false);
  });

  it("blocks on EACH guard independently", () => {
    expect(channelDeliveryBlocked({ ...base, rateLimited: true })).toBe(true);
    expect(channelDeliveryBlocked({ ...base, rateLimitResumed: true })).toBe(
      true
    );
    expect(channelDeliveryBlocked({ ...base, queueDispatched: true })).toBe(
      true
    );
    expect(channelDeliveryBlocked({ ...base, channelInFlight: true })).toBe(
      true
    );
  });

  it("REGRESSION: never injects a channel message into a rate-limited session", () => {
    expect(channelDeliveryBlocked({ ...base, rateLimited: true })).toBe(true);
  });

  it("REGRESSION: never interleaves with a same-tick resume Enter", () => {
    expect(channelDeliveryBlocked({ ...base, rateLimitResumed: true })).toBe(
      true
    );
  });
});
