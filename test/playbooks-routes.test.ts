import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

// Drive the real route handlers against an in-memory DB — only getDb() is swapped.
const holder = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => holder.db };
});

import { queries } from "@/lib/db";
import { GET, POST } from "@/app/api/playbooks/route";
import { PATCH, DELETE } from "@/app/api/playbooks/[id]/route";

const db = () => holder.db;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const req = (url: string, body?: unknown): any => ({
  url,
  json: async () => body ?? {},
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(() => {
  const mem = new Database(":memory:");
  createSchema(mem);
  runMigrations(mem);
  holder.db = mem;
});

beforeEach(() => {
  db().exec("DELETE FROM playbooks; DELETE FROM projects;");
  queries
    .createProject(db())
    .run("proj1", "P1", "~/p1", "claude", "sonnet", null, 1);
});

describe("POST/GET /api/playbooks", () => {
  it("creates a project-scoped pinned recipe and lists it", async () => {
    const res = await POST(
      req("http://x/api/playbooks", {
        name: "Arch",
        body: "npm not yarn",
        projectId: "proj1",
        pinned: true,
      })
    );
    expect(res.status).toBe(201);
    const created = (await res.json()).playbook;
    expect(created.pinned).toBe(true);
    expect(created.projectId).toBe("proj1");

    const listRes = await GET(req("http://x/api/playbooks?projectId=proj1"));
    const list = (await listRes.json()).playbooks;
    expect(list.map((p: { name: string }) => p.name)).toContain("Arch");
  });

  it("400 on an invalid body, 400 when the project doesn't exist", async () => {
    expect((await POST(req("http://x", { name: "", body: "x" }))).status).toBe(
      400
    );
    expect(
      (
        await POST(
          req("http://x", { name: "n", body: "b", projectId: "ghost" })
        )
      ).status
    ).toBe(400);
  });

  it("a GLOBAL recipe (no project) can never be pinned", async () => {
    const res = await POST(
      req("http://x", { name: "G", body: "b", pinned: true })
    );
    const pb = (await res.json()).playbook;
    expect(pb.projectId).toBeNull();
    expect(pb.pinned).toBe(false); // pin dropped for a global recipe
  });
});

describe("PATCH/DELETE /api/playbooks/[id]", () => {
  it("merges a partial edit, unpins, deletes, and 404s a missing id", async () => {
    const created = (
      await (
        await POST(
          req("http://x", {
            name: "N",
            body: "B",
            projectId: "proj1",
            pinned: true,
          })
        )
      ).json()
    ).playbook;

    const patched = (
      await (
        await PATCH(
          req("http://x", { name: "N2", pinned: false }),
          ctx(created.id)
        )
      ).json()
    ).playbook;
    expect(patched.name).toBe("N2");
    expect(patched.body).toBe("B"); // untouched fields merge
    expect(patched.pinned).toBe(false);

    expect((await DELETE(req("http://x"), ctx(created.id))).status).toBe(200);
    expect((await DELETE(req("http://x"), ctx(created.id))).status).toBe(404);
    expect(
      (await PATCH(req("http://x", { name: "z" }), ctx("nope"))).status
    ).toBe(404);
  });
});
