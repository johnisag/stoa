/**
 * Workflow examples — catalog integrity.
 *
 * The Examples tab links its "runnable" patterns to real templates, so a
 * dangling `templateId` would render a "Run this" button that goes nowhere.
 * Lock both directions: every example's `templateId` resolves to a real
 * template, AND every shipped template is discoverable from some example
 * (AGENTS.md: "lock anything easy to silently regress").
 */
import { describe, it, expect } from "vitest";
import { WORKFLOW_EXAMPLES } from "@/lib/pipeline/examples";
import {
  PIPELINE_TEMPLATES,
  getPipelineTemplate,
} from "@/lib/pipeline/templates";

describe("WORKFLOW_EXAMPLES integrity", () => {
  it("carries the full 16-pattern catalog", () => {
    expect(WORKFLOW_EXAMPLES.length).toBe(16);
  });

  it("every example has non-empty id, title, diagram, description", () => {
    for (const ex of WORKFLOW_EXAMPLES) {
      expect(ex.id.trim(), `id of "${ex.title}"`).not.toBe("");
      expect(ex.title.trim(), `title ${ex.id}`).not.toBe("");
      expect(ex.diagram.trim(), `diagram ${ex.id}`).not.toBe("");
      expect(ex.description.trim(), `description ${ex.id}`).not.toBe("");
    }
  });

  it("ids are unique", () => {
    const ids = WORKFLOW_EXAMPLES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every templateId resolves to a real template (no dangling 'Run this')", () => {
    for (const ex of WORKFLOW_EXAMPLES) {
      if (ex.templateId) {
        expect(
          getPipelineTemplate(ex.templateId),
          `example ${ex.id} → ${ex.templateId}`
        ).toBeDefined();
      }
    }
  });

  it("every shipped template is linked from an example", () => {
    const linked = new Set(
      WORKFLOW_EXAMPLES.map((e) => e.templateId).filter(Boolean)
    );
    for (const t of PIPELINE_TEMPLATES) {
      expect(
        linked.has(t.id),
        `template "${t.id}" not linked from any example`
      ).toBe(true);
    }
  });
});
