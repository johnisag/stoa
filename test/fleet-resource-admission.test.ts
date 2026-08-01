import { describe, expect, it } from "vitest";
import {
  admitFleetResourceWave,
  evaluateFleetResourceAdmission,
  normalizeFleetResourceLimits,
  type FleetResourceUnits,
} from "@/lib/fleet/resource-admission";

describe("Fleet resource admission", () => {
  it("normalizes every capacity and bounds hostile provider overrides", () => {
    const limits = normalizeFleetResourceLimits({
      pty: 999,
      transportHost: 0,
      verifier: 999,
      gitOperation: 999,
      mergeOperation: 999,
      worktreesPerRepo: 999,
      diskBytes: Number.MAX_SAFE_INTEGER,
      outputBytesPerMinute: Number.MAX_SAFE_INTEGER,
      artifactBytesPerMinute: Number.MAX_SAFE_INTEGER,
      eventFanoutPerMinute: Number.MAX_SAFE_INTEGER,
      providerCaps: {
        codex: 999,
        "../unsafe": 20,
        hermes: 3,
      },
    });
    expect(limits).toMatchObject({
      pty: 40,
      transportHost: 6,
      verifier: 16,
      gitOperation: 16,
      mergeOperation: 4,
      worktreesPerRepo: 40,
      diskBytes: 1024 ** 4,
      outputBytesPerMinute: 1024 ** 3,
      artifactBytesPerMinute: 1024 ** 3,
      eventFanoutPerMinute: 100_000,
      providerCaps: { codex: 40, hermes: 3 },
    });
  });

  it("requires all explicit worker resources and aggregates split lease rows", () => {
    const limits = normalizeFleetResourceLimits({
      pty: 2,
      transportHost: 2,
      gitOperation: 1,
      worktreesPerRepo: 1,
      providerCaps: { codex: 2 },
    });
    const usage: FleetResourceUnits[] = [
      { kind: "git_operation", key: "local", units: 0.5 },
      { kind: "git_operation", key: "local", units: 0.5 },
      { kind: "repo_worktree", key: "repo-1", units: 1 },
    ];
    const decision = evaluateFleetResourceAdmission({
      limits,
      usage,
      requested: [
        { kind: "pty", key: "local", units: 1 },
        { kind: "transport_host", key: "local", units: 1 },
        { kind: "provider", key: "codex", units: 1 },
        { kind: "git_operation", key: "local", units: 1 },
        { kind: "repo_worktree", key: "repo-1", units: 1 },
        { kind: "disk_bytes", key: "fleet", units: 1024 },
        { kind: "output_bytes_per_minute", key: "fleet", units: 1024 },
        { kind: "artifact_bytes_per_minute", key: "fleet", units: 1024 },
        { kind: "event_fanout_per_minute", key: "fleet", units: 1 },
      ],
    });
    expect(decision.admitted).toBe(false);
    expect(decision.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "git_operation", used: 1 }),
        expect.objectContaining({ kind: "repo_worktree", used: 1 }),
      ])
    );
  });

  it("gates verifier and merge operations independently", () => {
    const limits = normalizeFleetResourceLimits({
      verifier: 1,
      mergeOperation: 1,
    });
    expect(
      evaluateFleetResourceAdmission({
        limits,
        usage: [
          { kind: "verifier", key: "local", units: 1 },
          { kind: "merge_operation", key: "repo-1", units: 1 },
        ],
        requested: [
          { kind: "verifier", key: "local", units: 1 },
          { kind: "merge_operation", key: "repo-1", units: 1 },
        ],
      }).blocked.map((block) => block.kind)
    ).toEqual(["merge_operation", "verifier"]);
  });

  it("admits only one bounded local wave from forty candidates", () => {
    const candidates = Array.from({ length: 40 }, (_, index) => index);
    const limits = normalizeFleetResourceLimits({
      pty: 6,
      transportHost: 6,
      worktreesPerRepo: 12,
      providerCaps: { codex: 6 },
    });
    const admitted = admitFleetResourceWave({
      limits,
      usage: [],
      candidates,
      resources: (): FleetResourceUnits[] => [
        { kind: "pty", key: "local", units: 1 },
        { kind: "transport_host", key: "local", units: 1 },
        { kind: "provider", key: "codex", units: 1 },
        { kind: "repo_worktree", key: "repo-1", units: 1 },
      ],
    });
    expect(admitted).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("honors configurable provider caps", () => {
    const limits = normalizeFleetResourceLimits({
      providerCaps: { hermes: 3 },
    });
    expect(
      evaluateFleetResourceAdmission({
        limits,
        usage: [{ kind: "provider", key: "hermes", units: 3 }],
        requested: [{ kind: "provider", key: "hermes", units: 1 }],
      })
    ).toMatchObject({ admitted: false });
  });
});
