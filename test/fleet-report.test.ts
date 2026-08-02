import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { readBoundedRegularFile } from "@/lib/fleet/artifacts";
import {
  FLEET_REPORT_MAX_BYTES,
  FLEET_REPORT_SCHEMA_VERSION,
  hashFleetReportNonce,
  normalizeFleetReportPath,
  parseFleetTaskCompletionReport,
  readFleetTaskCompletionReport,
  type ExpectedFleetReportIdentity,
} from "@/lib/fleet/report";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const NONCE = "n".repeat(43);
const roots: string[] = [];

function expected(
  overrides: Partial<ExpectedFleetReportIdentity> = {}
): ExpectedFleetReportIdentity {
  return {
    runId: "run-1",
    taskId: "task-1",
    workerId: "worker-1",
    attempt: 2,
    spawnRequestId: "spawn-1",
    nonceHash: hashFleetReportNonce(NONCE),
    baseSha: BASE,
    spawnedAt: "2026-08-01T11:00:00.000Z",
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: FLEET_REPORT_SCHEMA_VERSION,
    runId: "run-1",
    taskId: "task-1",
    workerId: "worker-1",
    attempt: 2,
    spawnRequestId: "spawn-1",
    nonce: NONCE,
    baseSha: BASE,
    headSha: HEAD,
    submittedAt: "2026-08-01T11:55:00.000Z",
    status: "succeeded",
    summary: "Implemented the requested change.",
    filesChanged: ["lib/fleet/report.ts", "test\\fleet-report.test.ts"],
    verification: [
      { command: "npm test", result: "pass", evidence: "42 tests passed" },
    ],
    risks: [],
    followUps: [],
    mergeReadiness: "ready",
    markdown: "# Fleet Task Completion Report",
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  );
});

describe("Fleet completion report validation", () => {
  it("accepts one exact, nonce-bound attempt and normalizes paths", () => {
    const parsed = parseFleetTaskCompletionReport(report(), expected(), NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.report.filesChanged).toEqual([
      "lib/fleet/report.ts",
      "test/fleet-report.test.ts",
    ]);
    expect(parsed.report.submittedAt).toBe("2026-08-01T11:55:00.000Z");
  });

  it.each([
    ["runId", "run-2"],
    ["taskId", "task-2"],
    ["workerId", "worker-2"],
    ["attempt", 3],
    ["spawnRequestId", "spawn-2"],
    ["baseSha", "c".repeat(40)],
  ])("rejects a mismatched %s", (field, value) => {
    expect(
      parseFleetTaskCompletionReport(
        report({ [field]: value }),
        expected(),
        NOW
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining(field) });
  });

  it("rejects a wrong or malformed nonce without returning the secret", () => {
    for (const nonce of ["x".repeat(43), "short", 42]) {
      expect(
        parseFleetTaskCompletionReport(report({ nonce }), expected(), NOW)
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining("nonce"),
      });
    }
    const parsed = parseFleetTaskCompletionReport(report(), expected(), NOW);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.report).not.toHaveProperty("nonce");
  });

  it("rejects replay/staleness and timestamps outside the attempt", () => {
    expect(
      parseFleetTaskCompletionReport(
        report({ submittedAt: "2026-07-30T11:00:00.000Z" }),
        expected({ spawnedAt: "2026-07-30T10:00:00.000Z" }),
        NOW
      )
    ).toMatchObject({ ok: false, error: "fleet report is stale" });
    expect(
      parseFleetTaskCompletionReport(
        report({ submittedAt: "2026-08-01T10:00:00.000Z" }),
        expected(),
        NOW
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining("outside") });
    expect(
      parseFleetTaskCompletionReport(
        report({ submittedAt: "2026-08-01T12:06:00.000Z" }),
        expected(),
        NOW
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining("outside") });
  });

  it.each([
    "../secret",
    "a/../../secret",
    "/etc/passwd",
    "C:\\Users\\secret",
    "C:relative-secret",
    "folder/name:alternate-stream",
    "a//b",
    "./a",
    "a/./b",
    "a/../b",
    "a\u0000b",
  ])("rejects unsafe reported path %j", (file) => {
    expect(normalizeFleetReportPath(file)).toBeNull();
    expect(
      parseFleetTaskCompletionReport(
        report({ filesChanged: [file] }),
        expected(),
        NOW
      )
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("unsafe path"),
    });
  });

  it("rejects malformed identities, SHAs, statuses, testimony, and oversized JSON", () => {
    for (const invalid of [
      "not-json",
      JSON.stringify([]),
      report({ schemaVersion: 99 }),
      report({ headSha: "deadbeef" }),
      report({ status: "done" }),
      report({ status: "failed", mergeReadiness: "ready" }),
      report({ verification: [{ command: "npm test", result: "maybe" }] }),
      report({ filesChanged: ["a", "a"] }),
      JSON.stringify({ padding: "x".repeat(FLEET_REPORT_MAX_BYTES) }),
    ]) {
      expect(parseFleetTaskCompletionReport(invalid, expected(), NOW).ok).toBe(
        false
      );
    }
  });
});

describe("Fleet artifact bounded reader", () => {
  it("reads a regular report through the bounded report adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "stoa-fleet-report-"));
    roots.push(root);
    const file = join(root, "report.json");
    await writeFile(file, report(), "utf8");
    await expect(
      readFleetTaskCompletionReport(file, expected(), NOW)
    ).resolves.toMatchObject({ ok: true });
  });

  it("rejects missing files, directories, oversize files, and symlinks where supported", async () => {
    const root = await mkdtemp(join(tmpdir(), "stoa-fleet-report-"));
    roots.push(root);
    await expect(
      readBoundedRegularFile(join(root, "missing"), 32)
    ).resolves.toMatchObject({ ok: false, missing: true });
    const directory = join(root, "directory");
    await mkdir(directory);
    await expect(readBoundedRegularFile(directory, 32)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("not a regular file"),
    });
    const large = join(root, "large");
    await writeFile(large, "x".repeat(33));
    await expect(readBoundedRegularFile(large, 32)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("exceeds"),
    });

    const target = join(root, "target");
    const link = join(root, "link");
    await writeFile(target, "safe");
    try {
      await symlink(target, link, "file");
      await expect(readBoundedRegularFile(link, 32)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("not a regular file"),
      });
    } catch {
      // Windows CI may not grant symlink creation privilege.
    }
  });
});
