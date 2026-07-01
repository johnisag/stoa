import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

// Drive the REAL route handlers against an in-memory DB — the lib/db `db`
// export (used by the routes + lib/projects) is swapped for the test DB.
const holder = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    get db() {
      return holder.db;
    },
    getDb: () => holder.db,
  };
});

import { queries } from "@/lib/db";
import { POST } from "@/app/api/projects/[id]/startup-commands/route";
import {
  PATCH,
  DELETE,
} from "@/app/api/projects/[id]/startup-commands/[cmdId]/route";

const db = () => holder.db;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const req = (body?: unknown): any => ({
  url: "http://x",
  json: async () => body ?? {},
  headers: new Headers({ "content-type": "application/json" }),
});
const ctx = (id: string, cmdId?: string) => ({
  params: Promise.resolve({ id, cmdId: cmdId ?? "" }),
});

beforeAll(() => {
  const mem = new Database(":memory:");
  createSchema(mem);
  runMigrations(mem);
  holder.db = mem;
});

beforeEach(() => {
  db().exec("DELETE FROM project_startup_commands; DELETE FROM projects;");
  queries
    .createProject(db())
    .run("proj1", "P1", "~/p1", "claude", "sonnet", null, 1);
  queries
    .createProject(db())
    .run("proj2", "P2", "~/p2", "claude", "sonnet", null, 2);
});

describe("POST /api/projects/[id]/startup-commands (#14b)", () => {
  it("creates a command and 400s on shell metacharacters", async () => {
    const ok = await POST(
      req({ name: "Build", command: "npm run build" }),
      ctx("proj1")
    );
    expect(ok.status).toBe(201);

    const evil = await POST(
      req({ name: "evil", command: "npm run build; rm -rf /" }),
      ctx("proj1")
    );
    expect(evil.status).toBe(400);
    expect(queries.getProjectStartupCommands(db()).all("proj1")).toHaveLength(
      1
    );
  });

  it("404s for an unknown project", async () => {
    const res = await POST(req({ name: "x", command: "node -v" }), ctx("nope"));
    expect(res.status).toBe(404);
  });
});

describe("PATCH/DELETE ownership check (#14b — red-team lock)", () => {
  beforeEach(() => {
    queries
      .createProjectStartupCommand(db())
      .run("c1", "proj1", "Build", "npm run build", 0);
  });

  it("PATCH refuses a cmdId belonging to ANOTHER project (404, unchanged)", async () => {
    const res = await PATCH(
      req({ command: "node evil.js" }),
      ctx("proj2", "c1") // c1 belongs to proj1
    );
    expect(res.status).toBe(404);
    const row = queries.getProjectStartupCommand(db()).get("c1") as {
      command: string;
    };
    expect(row.command).toBe("npm run build"); // untouched
  });

  it("DELETE refuses a cmdId belonging to ANOTHER project (404, still there)", async () => {
    const res = await DELETE(req(), ctx("proj2", "c1"));
    expect(res.status).toBe(404);
    expect(queries.getProjectStartupCommand(db()).get("c1")).toBeTruthy();
  });

  it("PATCH on the OWNING project updates (and re-validates the command)", async () => {
    const ok = await PATCH(
      req({ command: "npm run build -- --prod" }),
      ctx("proj1", "c1")
    );
    expect(ok.status).toBe(200);

    const evil = await PATCH(req({ command: "x && y" }), ctx("proj1", "c1"));
    expect(evil.status).toBe(400);
  });

  it("DELETE on the OWNING project removes the command", async () => {
    const res = await DELETE(req(), ctx("proj1", "c1"));
    expect(res.status).toBe(200);
    expect(queries.getProjectStartupCommand(db()).get("c1")).toBeUndefined();
  });
});
