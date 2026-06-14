/**
 * Workflow snippets — integrity checks.
 *
 * Every snippet must have a non-empty id/title/description/task and a valid
 * agent, so an added step never arrives malformed.
 */
import { describe, it, expect } from "vitest";
import { WORKFLOW_SNIPPETS } from "@/lib/pipeline/snippets";
import { PROVIDER_IDS } from "@/lib/providers/registry";

describe("WORKFLOW_SNIPPETS", () => {
  it("has at least one snippet", () => {
    expect(WORKFLOW_SNIPPETS.length).toBeGreaterThan(0);
  });

  it("every snippet has non-empty id, title, description, task", () => {
    for (const s of WORKFLOW_SNIPPETS) {
      expect(s.id.trim(), `id of "${s.title}"`).not.toBe("");
      expect(s.title.trim(), `title of "${s.id}"`).not.toBe("");
      expect(s.description.trim(), `description of "${s.id}"`).not.toBe("");
      expect(s.task.trim(), `task of "${s.id}"`).not.toBe("");
    }
  });

  it("ids are unique", () => {
    const ids = WORKFLOW_SNIPPETS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every agent is a known provider", () => {
    for (const s of WORKFLOW_SNIPPETS) {
      expect(
        PROVIDER_IDS.includes(s.agent),
        `snippet "${s.id}" agent "${s.agent}"`
      ).toBe(true);
    }
  });
});
