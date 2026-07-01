import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db/queries";
import {
  resolveStartupSpawn,
  runStartupCommands,
  type ExecFileFn,
} from "@/lib/startup-commands";

// ---------------------------------------------------------------------------
// resolveStartupSpawn — the Windows .cmd/.bat routing (mirrors
// resolveDevServerSpawn; this test locks BOTH from drifting apart).
// ---------------------------------------------------------------------------

describe("resolveStartupSpawn (#14b — .cmd routing, argv only)", () => {
  it("passes a plain binary through unchanged on POSIX", () => {
    expect(
      resolveStartupSpawn("/usr/bin/npm", ["run", "build"], false)
    ).toEqual({
      file: "/usr/bin/npm",
      args: ["run", "build"],
    });
  });

  it("routes a Windows .cmd shim through cmd.exe /c (shell stays false)", () => {
    const r = resolveStartupSpawn(
      "C:\\nodejs\\npm.cmd",
      ["run", "build"],
      true
    );
    // ComSpec-tolerant, like dev-server-spawn.test.ts: on a real Windows box
    // the file is the ComSpec path, elsewhere the bare "cmd.exe" fallback.
    expect(r.file.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(r.args).toEqual(["/c", "C:\\nodejs\\npm.cmd", "run", "build"]);
  });

  it("routes .bat and is case-insensitive; .exe is spawned directly", () => {
    expect(
      resolveStartupSpawn("C:\\t\\x.BAT", ["a"], true).file.toLowerCase()
    ).toMatch(/cmd\.exe$/);
    expect(resolveStartupSpawn("C:\\t\\node.exe", ["a"], true)).toEqual({
      file: "C:\\t\\node.exe",
      args: ["a"],
    });
  });

  it("never routes through cmd.exe off Windows even for a .cmd path", () => {
    expect(resolveStartupSpawn("/weird/x.cmd", [], false).file).toBe(
      "/weird/x.cmd"
    );
  });
});

// ---------------------------------------------------------------------------
// runStartupCommands — injected exec + resolver, no real processes.
// ---------------------------------------------------------------------------

function capture() {
  const calls: Array<{
    file: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }> = [];
  const exec: ExecFileFn = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts.cwd, env: opts.env });
    return { stdout: "ok", stderr: "" };
  };
  return { calls, exec };
}

describe("runStartupCommands (#14b — safe argv exec)", () => {
  it("tokenizes, resolves, and execs each command as ARGV (never a shell string)", async () => {
    const { calls, exec } = capture();
    const results = await runStartupCommands(
      [
        { name: "Build", command: "npm run build" },
        { name: "Codegen", command: 'node scripts/gen.js --out "dist dir"' },
      ],
      "/wt",
      { WORKTREE_PATH: "/wt", PORT: "3100" },
      { execFileFn: exec, resolveBin: (n) => `/bin/${n}`, onWindows: false }
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      file: "/bin/npm",
      args: ["run", "build"],
      cwd: "/wt",
    });
    // quoted arg stays ONE token; env vars ride the spawn env, not the string
    expect(calls[1].args).toEqual(["scripts/gen.js", "--out", "dist dir"]);
    expect(calls[1].env.WORKTREE_PATH).toBe("/wt");
    expect(calls[1].env.PORT).toBe("3100");
    expect(results.every((r) => r.success)).toBe(true);
  });

  it("routes npm's .cmd shim via cmd.exe /c on Windows", async () => {
    const { calls, exec } = capture();
    await runStartupCommands(
      [{ name: "Build", command: "npm run build" }],
      "C:\\wt",
      {},
      {
        execFileFn: exec,
        resolveBin: () => "C:\\nodejs\\npm.cmd",
        onWindows: true,
      }
    );
    expect(calls[0].file.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(calls[0].args).toEqual([
      "/c",
      "C:\\nodejs\\npm.cmd",
      "run",
      "build",
    ]);
  });

  it("REJECTS shell metacharacters (a step failure, not an exec)", async () => {
    const { calls, exec } = capture();
    const results = await runStartupCommands(
      [{ name: "evil", command: "npm run build; rm -rf /" }],
      "/wt",
      {},
      { execFileFn: exec, resolveBin: (n) => `/bin/${n}`, onWindows: false }
    );
    expect(calls).toHaveLength(0); // never reached exec
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBeTruthy();
  });

  it("a missing binary fails that step; later steps STILL run", async () => {
    const { calls, exec } = capture();
    const results = await runStartupCommands(
      [
        { name: "gone", command: "not-a-real-binary --x" },
        { name: "ok", command: "node -v" },
      ],
      "/wt",
      {},
      {
        execFileFn: exec,
        resolveBin: (n) => (n === "node" ? "/bin/node" : null),
        onWindows: false,
      }
    );
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("not found on PATH");
    expect(results[1].success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("an exec failure records output+error and never throws", async () => {
    const exec: ExecFileFn = async () => {
      const err = new Error("exit 1") as Error & {
        stdout?: string;
        stderr?: string;
      };
      err.stdout = "partial build log";
      err.stderr = "TS2345 type error";
      throw err;
    };
    const results = await runStartupCommands(
      [{ name: "Build", command: "npm run build" }],
      "/wt",
      {},
      { execFileFn: exec, resolveBin: (n) => `/bin/${n}`, onWindows: false }
    );
    expect(results[0].success).toBe(false);
    expect(results[0].output).toBe("partial build log");
    expect(results[0].error).toBe("TS2345 type error");
  });

  it("no commands → no exec, empty results", async () => {
    const { calls, exec } = capture();
    expect(
      await runStartupCommands([], "/wt", {}, { execFileFn: exec })
    ).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DB layer — CRUD + the CASCADE lock (mirrors playbooks-server.test.ts).
// ---------------------------------------------------------------------------

describe("project_startup_commands DB (#14b)", () => {
  function mkDb() {
    const db = new Database(":memory:");
    createSchema(db);
    runMigrations(db);
    queries
      .createProject(db)
      .run("proj1", "P1", "~/p1", "claude", "sonnet", null, 1);
    return db;
  }

  it("CRUD round-trip ordered by sort_order", () => {
    const db = mkDb();
    queries
      .createProjectStartupCommand(db)
      .run("c2", "proj1", "Second", "npm run gen", 1);
    queries
      .createProjectStartupCommand(db)
      .run("c1", "proj1", "First", "npm run build", 0);

    const rows = queries.getProjectStartupCommands(db).all("proj1") as Array<{
      id: string;
      name: string;
    }>;
    expect(rows.map((r) => r.id)).toEqual(["c1", "c2"]);

    queries
      .updateProjectStartupCommand(db)
      .run("First!", "npm run build -- --prod", 0, "c1");
    const updated = queries.getProjectStartupCommand(db).get("c1") as {
      name: string;
      command: string;
    };
    expect(updated.name).toBe("First!");
    expect(updated.command).toBe("npm run build -- --prod");

    queries.deleteProjectStartupCommand(db).run("c2");
    expect(queries.getProjectStartupCommands(db).all("proj1")).toHaveLength(1);
  });

  // Locks the FK behavior the schema relies on (no manual cleanup in
  // deleteProject): deleting a project must CASCADE its startup commands.
  it("deleting a project CASCADEs its startup commands", () => {
    const db = mkDb();
    queries
      .createProjectStartupCommand(db)
      .run("c1", "proj1", "Build", "npm run build", 0);
    db.exec("DELETE FROM projects WHERE id = 'proj1'");
    expect(queries.getProjectStartupCommands(db).all("proj1")).toHaveLength(0);
  });
});
