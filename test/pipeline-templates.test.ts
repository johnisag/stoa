import { describe, it, expect } from "vitest";
import {
  PIPELINE_TEMPLATES,
  getPipelineTemplate,
} from "../lib/pipeline/templates";
import { validateSpec } from "../lib/pipeline/engine";

// Representative params per template (every required slot filled).
const SAMPLES: Record<string, Record<string, string>> = {
  "three-agent-review": {
    workingDirectory: "~/repos/app",
    task: "add a --json flag",
  },
  "judge-panel": { workingDirectory: "~/repos/app", task: "implement backoff" },
  "bug-repro-fix": {
    workingDirectory: "~/repos/app",
    bug: "drops the last row",
  },
  "issue-to-pr": {
    workingDirectory: "C:\\repos\\app",
    repoSlug: "octo/app",
    issue: "123",
  },
  "cross-platform-hunt": {
    workingDirectory: "~/repos/app",
    target: "the branch diff",
  },
  "coverage-booster": {
    workingDirectory: "~/repos/app",
    modules: "lib/a, lib/b, lib/c",
  },
  "dead-code-prune": { workingDirectory: "~/repos/app" },
  "refactor-with-net": {
    workingDirectory: "~/repos/app",
    target: "pricing logic",
  },
  "docs-audit": { workingDirectory: "~/repos/app" },
};

describe("pipeline templates", () => {
  it("every template's buildSpec produces an engine-valid spec", () => {
    for (const t of PIPELINE_TEMPLATES) {
      const spec = t.buildSpec(SAMPLES[t.id] ?? { workingDirectory: "~/x" });
      const res = validateSpec(spec);
      expect(res.errors, `${t.id}: ${JSON.stringify(res.errors)}`).toEqual([]);
      expect(res.valid).toBe(true);
      expect(spec.steps.length).toBeGreaterThan(0);
    }
  });

  it("stays valid on blank optional params (fallbacks keep tasks non-empty)", () => {
    for (const t of PIPELINE_TEMPLATES) {
      // Only the required repo path; every other slot blank.
      const spec = t.buildSpec({ workingDirectory: "~/repos/app" });
      const res = validateSpec(spec);
      expect(res.valid, `${t.id} blank: ${JSON.stringify(res.errors)}`).toBe(
        true
      );
      // No step task may be empty (the fallback guard).
      expect(spec.steps.every((s) => s.task.trim().length > 0)).toBe(true);
    }
  });

  it("has unique ids/step-ids and getPipelineTemplate resolves them", () => {
    const ids = PIPELINE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of PIPELINE_TEMPLATES) {
      expect(getPipelineTemplate(t.id)?.id).toBe(t.id);
      const spec = t.buildSpec(SAMPLES[t.id] ?? { workingDirectory: "~/x" });
      const stepIds = spec.steps.map((s) => s.id);
      expect(new Set(stepIds).size, `${t.id} dup step id`).toBe(stepIds.length);
    }
  });

  it("every template declares a workingDirectory param + non-empty name/description", () => {
    for (const t of PIPELINE_TEMPLATES) {
      expect(
        t.params.some((p) => p.name === "workingDirectory" && p.required),
        `${t.id} missing required workingDirectory param`
      ).toBe(true);
      expect(t.name.trim().length).toBeGreaterThan(0);
      expect(t.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("pins each template's mutation risk (and ships at least one read-only)", () => {
    expect(
      Object.fromEntries(PIPELINE_TEMPLATES.map((t) => [t.id, t.mutates]))
    ).toEqual({
      "three-agent-review": true,
      "judge-panel": true,
      "bug-repro-fix": true,
      "issue-to-pr": true,
      "cross-platform-hunt": true,
      "coverage-booster": true,
      "dead-code-prune": true,
      "refactor-with-net": true,
      "docs-audit": false,
    });
    expect(PIPELINE_TEMPLATES.some((t) => t.mutates === false)).toBe(true);
  });

  it("pins the static templates' step counts (catch an accidentally dropped step)", () => {
    const counts: Record<string, number> = {
      "three-agent-review": 5,
      "judge-panel": 4,
      "bug-repro-fix": 3,
      "issue-to-pr": 3,
      "cross-platform-hunt": 4,
      "dead-code-prune": 5,
      "refactor-with-net": 3,
      "docs-audit": 4,
    };
    for (const [id, n] of Object.entries(counts)) {
      const spec = getPipelineTemplate(id)!.buildSpec(
        SAMPLES[id] ?? { workingDirectory: "~/x" }
      );
      expect(spec.steps, `${id} step count`).toHaveLength(n);
    }
  });

  it("no step declares a model the engine would silently drop (Claude has no model flag)", () => {
    // Per-step model overrides are inert for the claude agent today, so templates
    // must not promise one. (Guards against re-introducing a misleading override.)
    for (const t of PIPELINE_TEMPLATES) {
      const spec = t.buildSpec(SAMPLES[t.id] ?? { workingDirectory: "~/x" });
      for (const s of spec.steps) {
        expect(s.model, `${t.id}/${s.id} unexpected model`).toBeUndefined();
      }
    }
  });

  it("coverage-booster fans out one writer per module, fanning into dedupe", () => {
    const t = getPipelineTemplate("coverage-booster")!;
    const spec = t.buildSpec({ workingDirectory: "~/x", modules: "a, b, c" });
    const writers = spec.steps.filter((s) => s.id.startsWith("write-tests-"));
    expect(writers).toHaveLength(3);
    const dedupe = spec.steps.find((s) => s.id === "dedupe-and-run")!;
    expect(dedupe.dependsOn).toEqual(writers.map((w) => w.id));
    // Blank modules still yields one writer (the fallback), still valid.
    const blank = t.buildSpec({ workingDirectory: "~/x", modules: "" });
    expect(
      blank.steps.filter((s) => s.id.startsWith("write-tests-"))
    ).toHaveLength(1);
    expect(validateSpec(blank).valid).toBe(true);
  });

  it("getPipelineTemplate returns undefined for an unknown id", () => {
    expect(getPipelineTemplate("nope")).toBeUndefined();
  });
});
