import { describe, expect, it } from "vitest";
import {
  FLEET_CAPABILITY_MAX_TTL_MS,
  FLEET_CAPABILITY_VERSION,
  FleetCapabilityValidationError,
  decideFleetCapabilityUse,
  hashFleetCapabilityToken,
  issueFleetCapability,
  isFleetCapabilityToken,
  matchesFleetCapabilityToken,
  revokeFleetCapability,
  type FleetCapabilityRecord,
  type FleetCapabilityScope,
} from "@/lib/fleet/capability";

const NOW = 2_000_000;
const PLAN_HASH = "a".repeat(64);
const OTHER_PLAN_HASH = "b".repeat(64);

function scope(
  overrides: Partial<FleetCapabilityScope> = {}
): FleetCapabilityScope {
  return {
    version: FLEET_CAPABILITY_VERSION,
    action: "fleet:approve",
    runId: "run-1",
    taskId: "task-1",
    workerId: "worker-1",
    attempt: 2,
    boundHash: { kind: "plan", value: PLAN_HASH },
    ...overrides,
  };
}

function issued(
  overrides: Partial<FleetCapabilityScope> = {},
  options: Parameters<typeof issueFleetCapability>[1] = {}
) {
  return issueFleetCapability(scope(overrides), {
    issuedAtMs: NOW,
    ttlMs: 10_000,
    ...options,
  });
}

describe("Fleet capability issuance", () => {
  it("mints unique opaque 256-bit tokens and a hash-only record", () => {
    const first = issued();
    const second = issued();

    expect(first.token).toMatch(/^stoa_fleet_v1_[A-Za-z0-9_-]{43}$/);
    expect(second.token).not.toBe(first.token);
    expect(first.record.id).not.toBe(second.record.id);
    expect(first.record.tokenHash).toBe(hashFleetCapabilityToken(first.token));
    expect(first.record.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(first.record)).not.toContain(first.token);
    expect(first.record).toMatchObject({
      scope: scope(),
      useMode: "one_use",
      issuedAtMs: NOW,
      expiresAtMs: NOW + 10_000,
      revokedAtMs: null,
      consumedAtMs: null,
    });
  });

  it("copies nested scope data instead of retaining the caller's object", () => {
    const input = scope();
    const result = issueFleetCapability(input, {
      issuedAtMs: NOW,
      ttlMs: 100,
    });
    (input.boundHash as { value: string }).value = OTHER_PLAN_HASH;
    expect(result.record.scope.boundHash?.value).toBe(PLAN_HASH);
  });

  it("supports an explicitly reusable capability without consumed state", () => {
    const result = issued({}, { useMode: "reusable" });
    const first = decideFleetCapabilityUse(
      result.record,
      result.token,
      scope(),
      NOW + 1
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.atomicConsumption).toBeNull();
    expect(first.nextRecord.consumedAtMs).toBeNull();
    expect(
      decideFleetCapabilityUse(first.nextRecord, result.token, scope(), NOW + 2)
        .ok
    ).toBe(true);
  });

  it.each([
    ["unknown action", { action: "fleet:root" }],
    ["blank run", { runId: "" }],
    ["trimmed task", { taskId: " task-1" }],
    ["zero attempt", { attempt: 0 }],
    ["fractional attempt", { attempt: 1.5 }],
    ["unknown hash kind", { boundHash: { kind: "commit", value: PLAN_HASH } }],
    ["short hash", { boundHash: { kind: "plan", value: "abc" } }],
    [
      "uppercase hash",
      { boundHash: { kind: "plan", value: PLAN_HASH.toUpperCase() } },
    ],
  ])("rejects invalid scope: %s", (_name, override) => {
    expect(() =>
      issueFleetCapability(scope(override as Partial<FleetCapabilityScope>), {
        issuedAtMs: NOW,
      })
    ).toThrow(FleetCapabilityValidationError);
  });

  it("rejects unsupported versions, time overflow, and invalid TTLs", () => {
    expect(() =>
      issueFleetCapability(
        scope({ version: 2 as typeof FLEET_CAPABILITY_VERSION }),
        { issuedAtMs: NOW }
      )
    ).toThrow(/version/);
    for (const ttlMs of [0, -1, 1.5, FLEET_CAPABILITY_MAX_TTL_MS + 1]) {
      expect(() => issued({}, { ttlMs })).toThrow(/ttlMs/);
    }
    expect(() =>
      issueFleetCapability(scope(), {
        issuedAtMs: Number.MAX_SAFE_INTEGER,
        ttlMs: 1,
      })
    ).toThrow(/expiry/);
  });
});

describe("Fleet capability token verification", () => {
  it("recognizes only the fixed-size opaque token syntax", () => {
    const result = issued();
    expect(isFleetCapabilityToken(result.token)).toBe(true);
    expect(isFleetCapabilityToken(`${result.token}x`)).toBe(false);
    expect(isFleetCapabilityToken("x".repeat(100_000))).toBe(false);
    expect(isFleetCapabilityToken(null)).toBe(false);
  });

  it("hashes deterministically and matches only the exact token", () => {
    const result = issued();
    expect(hashFleetCapabilityToken(result.token)).toBe(
      hashFleetCapabilityToken(result.token)
    );
    expect(
      matchesFleetCapabilityToken(result.token, result.record.tokenHash)
    ).toBe(true);
    expect(
      matchesFleetCapabilityToken(issued().token, result.record.tokenHash)
    ).toBe(false);
  });

  it.each([
    null,
    undefined,
    "",
    " stoa_fleet_v1_" + "A".repeat(43),
    "stoa_fleet_v1_" + "A".repeat(42),
    "stoa_fleet_v1_" + "A".repeat(44),
    "stoa_fleet_v2_" + "A".repeat(43),
    "stoa_fleet_v1_" + "!".repeat(43),
    "x".repeat(100_000),
  ])("rejects malformed token input without throwing: %j", (token) => {
    const result = issued();
    expect(() =>
      matchesFleetCapabilityToken(token, result.record.tokenHash)
    ).not.toThrow();
    expect(matchesFleetCapabilityToken(token, result.record.tokenHash)).toBe(
      false
    );
    expect(
      decideFleetCapabilityUse(result.record, token, scope(), NOW + 1)
    ).toEqual({ ok: false, reason: "malformed_token" });
  });

  it("fails closed on malformed stored hashes without throwing", () => {
    const result = issued();
    for (const hash of [null, "", "a".repeat(63), "z".repeat(64)]) {
      expect(() =>
        matchesFleetCapabilityToken(result.token, hash)
      ).not.toThrow();
      expect(matchesFleetCapabilityToken(result.token, hash)).toBe(false);
    }
    const malformed = { ...result.record, tokenHash: "bad" };
    expect(
      decideFleetCapabilityUse(
        malformed as FleetCapabilityRecord,
        result.token,
        scope(),
        NOW + 1
      )
    ).toEqual({ ok: false, reason: "invalid_record" });
  });

  it("distinguishes a well-formed unknown token from malformed input", () => {
    const result = issued();
    const other = issued();
    expect(
      decideFleetCapabilityUse(result.record, other.token, scope(), NOW + 1)
    ).toEqual({ ok: false, reason: "token_mismatch" });
  });
});

describe("Fleet capability exact-scope decisions", () => {
  it("allows the exact request and returns an atomic one-use consumption", () => {
    const result = issued();
    const decision = decideFleetCapabilityUse(
      result.record,
      result.token,
      scope(),
      NOW + 1
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.nextRecord.consumedAtMs).toBe(NOW + 1);
    expect(decision.atomicConsumption).toEqual({
      capabilityId: result.record.id,
      tokenHash: result.record.tokenHash,
      expectedConsumedAtMs: null,
      consumedAtMs: NOW + 1,
    });
    expect(result.record.consumedAtMs).toBeNull();
  });

  it("rejects replay after applying the returned next record", () => {
    const result = issued();
    const first = decideFleetCapabilityUse(
      result.record,
      result.token,
      scope(),
      NOW + 1
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(
      decideFleetCapabilityUse(first.nextRecord, result.token, scope(), NOW + 2)
    ).toEqual({ ok: false, reason: "consumed" });
  });

  it.each([
    ["wrong_action", { action: "fleet:merge" }],
    ["wrong_run", { runId: "run-2" }],
    ["wrong_task", { taskId: "task-2" }],
    ["wrong_task", { taskId: null }],
    ["wrong_worker", { workerId: "worker-2" }],
    ["wrong_worker", { workerId: null }],
    ["wrong_attempt", { attempt: 3 }],
    ["wrong_attempt", { attempt: null }],
    ["wrong_hash", { boundHash: { kind: "plan", value: OTHER_PLAN_HASH } }],
    ["wrong_hash", { boundHash: { kind: "execution", value: PLAN_HASH } }],
    ["wrong_hash", { boundHash: null }],
  ] as const)("rejects exact scope mismatch: %s", (reason, override) => {
    const result = issued();
    expect(
      decideFleetCapabilityUse(
        result.record,
        result.token,
        scope(override as Partial<FleetCapabilityScope>),
        NOW + 1
      )
    ).toEqual({ ok: false, reason });
  });

  it("supports an exact Git SHA-1 head binding", () => {
    const head = "c".repeat(40);
    const exact = scope({
      action: "fleet:merge",
      boundHash: { kind: "head", value: head },
    });
    const result = issueFleetCapability(exact, {
      issuedAtMs: NOW,
      ttlMs: 100,
    });
    expect(
      decideFleetCapabilityUse(result.record, result.token, exact, NOW + 1).ok
    ).toBe(true);
  });

  it("requires explicit nulls and matches an intentionally run-only scope", () => {
    const exact = scope({
      action: "fleet:read",
      taskId: null,
      workerId: null,
      attempt: null,
      boundHash: null,
    });
    const result = issueFleetCapability(exact, {
      issuedAtMs: NOW,
      ttlMs: 100,
      useMode: "reusable",
    });
    expect(
      decideFleetCapabilityUse(result.record, result.token, exact, NOW + 1).ok
    ).toBe(true);
  });

  it("rejects malformed requests and an unsupported request version", () => {
    const result = issued();
    expect(
      decideFleetCapabilityUse(
        result.record,
        result.token,
        { ...scope(), runId: "" },
        NOW + 1
      )
    ).toEqual({ ok: false, reason: "invalid_request" });
    expect(
      decideFleetCapabilityUse(
        result.record,
        result.token,
        { ...scope(), version: 2 as typeof FLEET_CAPABILITY_VERSION },
        NOW + 1
      )
    ).toEqual({ ok: false, reason: "unsupported_version" });
  });
});

describe("Fleet capability lifetime state", () => {
  it("is invalid before issuance, valid before expiry, and expired at the boundary", () => {
    const result = issued();
    expect(
      decideFleetCapabilityUse(result.record, result.token, scope(), NOW - 1)
    ).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(
      decideFleetCapabilityUse(
        result.record,
        result.token,
        scope(),
        NOW + 9_999
      ).ok
    ).toBe(true);
    expect(
      decideFleetCapabilityUse(
        result.record,
        result.token,
        scope(),
        NOW + 10_000
      )
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects revoked tokens and revocation is immutable/idempotent", () => {
    const result = issued();
    const revoked = revokeFleetCapability(result.record, NOW + 1);
    const revokedAgain = revokeFleetCapability(revoked, NOW + 2);
    expect(revoked.revokedAtMs).toBe(NOW + 1);
    expect(revokedAgain.revokedAtMs).toBe(NOW + 1);
    expect(result.record.revokedAtMs).toBeNull();
    expect(
      decideFleetCapabilityUse(revoked, result.token, scope(), NOW + 2)
    ).toEqual({ ok: false, reason: "revoked" });
  });

  it("fails closed for malformed durable records", () => {
    const result = issued();
    const records = [
      { ...result.record, id: "" },
      { ...result.record, expiresAtMs: result.record.issuedAtMs },
      { ...result.record, revokedAtMs: result.record.issuedAtMs - 1 },
      { ...result.record, consumedAtMs: result.record.issuedAtMs - 1 },
      { ...result.record, consumedAtMs: result.record.expiresAtMs },
      { ...result.record, useMode: "forever" },
      { ...result.record, useMode: "reusable", consumedAtMs: NOW + 1 },
      {
        ...result.record,
        scope: { ...result.record.scope, action: "fleet:root" },
      },
    ];
    for (const record of records) {
      expect(
        decideFleetCapabilityUse(
          record as FleetCapabilityRecord,
          result.token,
          scope(),
          NOW + 1
        )
      ).toEqual({ ok: false, reason: "invalid_record" });
    }
  });

  it("reports an unsupported durable version after authenticating the token", () => {
    const result = issued();
    const futureVersion = {
      ...result.record,
      scope: { ...result.record.scope, version: 2 },
    } as unknown as FleetCapabilityRecord;
    expect(
      decideFleetCapabilityUse(futureVersion, result.token, scope(), NOW + 1)
    ).toEqual({ ok: false, reason: "unsupported_version" });
  });

  it("rejects revocation timestamps that precede issuance", () => {
    const result = issued();
    expect(() =>
      revokeFleetCapability(result.record, result.record.issuedAtMs - 1)
    ).toThrow(/precede/);
  });
});
