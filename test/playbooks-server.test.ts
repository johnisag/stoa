import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db/queries";
import { resolvePlaybookParts } from "@/lib/playbooks-server";

// resolvePlaybookParts takes the db as a param, so we drive it against a real
// in-memory SQLite — exercising the queries + the project-scoping guard.
const state = { db: null as unknown as Database.Database };
const db = () => state.db;

beforeAll(() => {
  const mem = new Database(":memory:");
  createSchema(mem);
  runMigrations(mem);
  state.db = mem;
});

beforeEach(() => {
  db().exec("DELETE FROM playbooks; DELETE FROM projects;");
  queries
    .createProject(db())
    .run("proj1", "P1", "~/p1", "claude", "sonnet", null, 1);
  queries
    .createProject(db())
    .run("proj2", "P2", "~/p2", "claude", "sonnet", null, 2);
});

const mkPlaybook = (
  id: string,
  name: string,
  body: string,
  projectId: string | null,
  pinned: number
) => queries.createPlaybook(db()).run(id, name, body, projectId, pinned);

describe("resolvePlaybookParts (#13)", () => {
  it("builds the pinned-knowledge block from a project's PINNED playbooks only", () => {
    mkPlaybook("k1", "Arch", "npm not yarn", "proj1", 1);
    mkPlaybook("k2", "Recipe", "not injected", "proj1", 0);
    const { pinnedKnowledge } = resolvePlaybookParts(db(), "proj1");
    expect(pinnedKnowledge).toContain("## Arch");
    expect(pinnedKnowledge).toContain("npm not yarn");
    expect(pinnedKnowledge).not.toContain("not injected"); // unpinned excluded
  });

  it("resolves a selected recipe body when it belongs to the project", () => {
    mkPlaybook("r1", "Fix flake", "1. rerun 2. isolate", "proj1", 0);
    expect(resolvePlaybookParts(db(), "proj1", "r1").playbook).toBe(
      "1. rerun 2. isolate"
    );
  });

  it("resolves a GLOBAL recipe (project_id null) for any project", () => {
    mkPlaybook("g1", "Global", "global body", null, 0);
    expect(resolvePlaybookParts(db(), "proj1", "g1").playbook).toBe(
      "global body"
    );
    expect(resolvePlaybookParts(db(), "proj2", "g1").playbook).toBe(
      "global body"
    );
  });

  it("REJECTS a recipe from ANOTHER project — no cross-project pull", () => {
    mkPlaybook("r2", "P2 recipe", "other project's steps", "proj2", 0);
    expect(resolvePlaybookParts(db(), "proj1", "r2").playbook).toBeUndefined();
  });

  it("empty when no pins + a missing/unknown playbook id", () => {
    const { pinnedKnowledge, playbook } = resolvePlaybookParts(
      db(),
      "proj1",
      "does-not-exist"
    );
    expect(pinnedKnowledge).toBe("");
    expect(playbook).toBeUndefined();
  });

  it("no project → no pinned knowledge (a global-only launch)", () => {
    expect(resolvePlaybookParts(db(), null).pinnedKnowledge).toBe("");
    expect(resolvePlaybookParts(db(), undefined).pinnedKnowledge).toBe("");
  });

  // Locks the FK behavior the schema relies on (no manual cleanup in deleteProject):
  // deleting a project must CASCADE its playbooks. Runs on the CI matrix, so it also
  // catches any platform where better-sqlite3's foreign_keys default were off.
  it("deleting a project CASCADEs its playbooks; a global recipe survives", () => {
    mkPlaybook("k1", "Arch", "npm", "proj1", 1);
    mkPlaybook("g1", "Global", "g", null, 0);
    db().exec("DELETE FROM projects WHERE id = 'proj1'");
    const count = (col: string) =>
      (
        db()
          .prepare(`SELECT COUNT(*) AS n FROM playbooks WHERE ${col}`)
          .get() as { n: number }
      ).n;
    expect(count("project_id = 'proj1'")).toBe(0); // cascaded away
    expect(count("project_id IS NULL")).toBe(1); // global untouched
  });
});
