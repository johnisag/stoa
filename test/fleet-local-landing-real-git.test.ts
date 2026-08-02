import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createSchema } from "@/lib/db/schema";
import { queries } from "@/lib/db";
import { runGit } from "@/lib/git";
import {
  __fleetMergeTesting,
  getFleetMergeStatus,
} from "@/lib/fleet/merge-runtime";
import type { FleetMergeRunRow } from "@/lib/fleet/merge-readiness";
import { tmpDir } from "@/lib/platform";

describe("Fleet local landing against real Git", () => {
  let scratch: string | null = null;

  afterEach(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    scratch = null;
  });

  it("cannot mutate an unrelated checkout switched immediately after the target-ref CAS", async () => {
    scratch = await mkdtemp(join(tmpDir(), "stoa-fleet-local-race-"));
    const source = join(scratch, "source");
    const integrationWorktree = join(scratch, "integration");
    await runGit(scratch, ["init", "-b", "main", source], 30_000);
    await runGit(source, ["config", "user.name", "Fleet Test"], 30_000);
    await runGit(
      source,
      ["config", "user.email", "fleet-test@localhost"],
      30_000
    );
    await writeFile(join(source, "base.txt"), "base\n", "utf8");
    await runGit(source, ["add", "base.txt"], 30_000);
    await runGit(source, ["commit", "-m", "base"], 30_000);
    const baseSha = (
      await runGit(source, ["rev-parse", "HEAD"], 30_000)
    ).stdout.trim();
    await runGit(source, ["branch", "release", baseSha], 30_000);
    await runGit(
      source,
      [
        "worktree",
        "add",
        "-b",
        "fleet-integration",
        integrationWorktree,
        baseSha,
      ],
      30_000
    );
    await writeFile(
      join(integrationWorktree, "integration.txt"),
      "integrated\n",
      "utf8"
    );
    await runGit(integrationWorktree, ["add", "integration.txt"], 30_000);
    await runGit(integrationWorktree, ["commit", "-m", "integration"], 30_000);
    const integrationSha = (
      await runGit(integrationWorktree, ["rev-parse", "HEAD"], 30_000)
    ).stdout.trim();

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    createSchema(db);
    db.prepare(
      `INSERT INTO dispatch_repos
       (id, repo_path, repo_slug, agent_type, daily_quota, max_concurrency,
        base_branch, mode, enabled)
       VALUES ('real-repo', ?, '', 'codex', 10, 2, 'main', 'manual', 1)`
    ).run(source);
    db.prepare(
      `INSERT INTO fleet_runs
       (id, name, goal, repo_id, status, desired_state, merge_target,
        merge_request_kind, merge_requested_at, merge_requested_by,
        integration_state, integration_branch, integration_worktree,
        integration_base_sha, integration_head_sha, automation_base_sha)
       VALUES ('real-run', 'Real local landing', 'Prove checkout isolation',
        'real-repo', 'merging', 'running', 'local', 'manual', ?, 'test',
        'merging', 'fleet-integration', ?, ?, ?, ?)`
    ).run(
      new Date("2026-08-01T12:00:00.000Z").toISOString(),
      integrationWorktree,
      baseSha,
      integrationSha,
      baseSha
    );

    let switched = false;
    const git = async (
      cwd: string,
      args: string[],
      timeout = 60_000,
      maxBuffer = 8 * 1024 * 1024
    ) => {
      const result = await runGit(cwd, args, timeout, maxBuffer);
      if (cwd === source && args[0] === "update-ref") {
        await runGit(source, ["switch", "release"], 30_000);
        switched = true;
      }
      return result;
    };
    const deps = __fleetMergeTesting.runtimeDeps({
      db,
      git,
      id: () => "real-local-operation",
      leaseOwner: "real-local-landing-test",
      now: () => new Date("2026-08-01T12:00:00.000Z"),
    });
    const run = queries.getFleetRun(db).get("real-run") as FleetMergeRunRow;

    await expect(
      __fleetMergeTesting.finalizeLocal(deps, run, {
        repoPath: source,
        repoSlug: null,
        baseBranch: "main",
      })
    ).resolves.toBe(true);

    expect(switched).toBe(true);
    expect(
      (await runGit(source, ["branch", "--show-current"], 30_000)).stdout.trim()
    ).toBe("release");
    expect(
      (
        await runGit(source, ["rev-parse", "refs/heads/main"], 30_000)
      ).stdout.trim()
    ).toBe(integrationSha);
    expect(await readFile(join(source, "base.txt"), "utf8")).toBe("base\n");
    await expect(access(join(source, "integration.txt"))).rejects.toThrow();
    expect(
      (await runGit(source, ["status", "--porcelain=v1"], 30_000)).stdout
    ).toBe("");
    expect(getFleetMergeStatus("real-run", db)?.integration.state).toBe(
      "completed"
    );
    db.close();
  });
});
