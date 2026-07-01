import { describe, it, expect } from "vitest";
import {
  validatePlaybookInput,
  buildKnowledgeBlock,
  rowToPlaybook,
  PLAYBOOK_NAME_MAX,
  PLAYBOOK_BODY_MAX,
  MAX_PINNED_INJECTED,
  type PlaybookRow,
} from "@/lib/playbooks";

describe("validatePlaybookInput", () => {
  it("accepts + trims a valid name/body", () => {
    const r = validatePlaybookInput({
      name: "  Fix a flake  ",
      body: "  do X  ",
    });
    expect(r).toEqual({
      ok: true,
      value: { name: "Fix a flake", body: "do X" },
    });
  });
  it("rejects a missing/empty name or body", () => {
    expect(validatePlaybookInput({ name: "", body: "x" }).ok).toBe(false);
    expect(validatePlaybookInput({ name: "  ", body: "x" }).ok).toBe(false);
    expect(validatePlaybookInput({ name: "n", body: "" }).ok).toBe(false);
    expect(validatePlaybookInput({ name: "n" }).ok).toBe(false);
  });
  it("rejects a non-object", () => {
    expect(validatePlaybookInput(null).ok).toBe(false);
    expect(validatePlaybookInput("nope").ok).toBe(false);
  });
  it("enforces the length bounds", () => {
    expect(
      validatePlaybookInput({
        name: "x".repeat(PLAYBOOK_NAME_MAX + 1),
        body: "b",
      }).ok
    ).toBe(false);
    expect(
      validatePlaybookInput({
        name: "n",
        body: "x".repeat(PLAYBOOK_BODY_MAX + 1),
      }).ok
    ).toBe(false);
    // exactly at the bound is fine
    expect(
      validatePlaybookInput({
        name: "x".repeat(PLAYBOOK_NAME_MAX),
        body: "b",
      }).ok
    ).toBe(true);
  });
});

describe("buildKnowledgeBlock", () => {
  it("renders a titled section per pinned playbook under a header", () => {
    const block = buildKnowledgeBlock([
      { name: "Architecture", body: "Monorepo; npm not yarn." },
      { name: "", body: "Run tests with npm test." },
    ]);
    expect(block).toContain("PINNED PROJECT KNOWLEDGE");
    expect(block).toContain("## Architecture\nMonorepo; npm not yarn.");
    // an unnamed fact renders bare (no "## ")
    expect(block).toContain("Run tests with npm test.");
    expect(block).not.toContain("## \n");
  });
  it("is empty for no facts / only blank bodies", () => {
    expect(buildKnowledgeBlock([])).toBe("");
    expect(buildKnowledgeBlock([{ name: "x", body: "   " }])).toBe("");
  });
  it("caps to the FIRST MAX_PINNED_INJECTED (stable-ordered) of the input", () => {
    const many = Array.from({ length: MAX_PINNED_INJECTED + 5 }, (_, i) => ({
      name: `k${i}`,
      body: `fact ${i}`,
    }));
    const block = buildKnowledgeBlock(many);
    // only the first MAX_PINNED_INJECTED are included
    expect(block).toContain("## k0");
    expect(block).toContain(`## k${MAX_PINNED_INJECTED - 1}`);
    expect(block).not.toContain(`## k${MAX_PINNED_INJECTED}`);
  });
});

describe("rowToPlaybook", () => {
  it("maps snake_case + pinned 0/1 → boolean", () => {
    const row: PlaybookRow = {
      id: "p1",
      name: "R",
      body: "B",
      project_id: "proj1",
      pinned: 1,
      created_at: "2026-07-01",
      updated_at: "2026-07-01",
    };
    expect(rowToPlaybook(row)).toEqual({
      id: "p1",
      name: "R",
      body: "B",
      projectId: "proj1",
      pinned: true,
      createdAt: "2026-07-01",
      updatedAt: "2026-07-01",
    });
    expect(rowToPlaybook({ ...row, pinned: 0, project_id: null }).pinned).toBe(
      false
    );
    expect(rowToPlaybook({ ...row, project_id: null }).projectId).toBeNull();
  });
});
