/**
 * Conflict-aware decomposition — the planner's pure core. parsePlan is fail-closed
 * (any malformed output → ok:false, never spawn off it) and takes the LAST marker
 * block (latest-wins, like the critic markers); buildPlannerPrompt locks its
 * load-bearing instructions.
 */
import { describe, it, expect } from "vitest";
import { buildPlannerPrompt, parsePlan } from "../lib/dispatch/planner";

const block = (json: string) =>
  `prose…\nSTOA_PLAN_BEGIN\n${json}\nSTOA_PLAN_END\nmore`;

describe("parsePlan", () => {
  it("parses a well-formed block, normalizing claims", () => {
    const r = parsePlan(
      block(
        '{"tasks":[{"title":"A","body":"do a","claims":["./lib/a/","lib/a"]},{"title":"B","body":"do b","claims":["src/b.ts"]}]}'
      )
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tasks).toHaveLength(2);
      expect(r.tasks[0].claims).toEqual(["lib/a"]); // normalized + de-duped
      expect(r.tasks[1].title).toBe("B");
    }
  });

  it("takes the LAST block when two are present (latest-wins)", () => {
    const text =
      block('{"tasks":[{"title":"OLD","body":"x","claims":["lib/a"]}]}') +
      "\n" +
      block('{"tasks":[{"title":"NEW","body":"y","claims":["lib/b"]}]}');
    const r = parsePlan(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tasks[0].title).toBe("NEW");
  });

  it("fails closed on every malformed shape", () => {
    expect(parsePlan("").ok).toBe(false);
    expect(parsePlan("no markers here").ok).toBe(false);
    expect(parsePlan("STOA_PLAN_BEGIN\n{bad json}\nSTOA_PLAN_END").ok).toBe(
      false
    );
    expect(parsePlan(block('{"tasks":[]}')).ok).toBe(false); // empty tasks
    expect(parsePlan(block('{"tasks":[{"body":"x","claims":["a"]}]}')).ok).toBe(
      false
    ); // no title
    expect(
      parsePlan(block('{"tasks":[{"title":"A","body":"x","claims":[]}]}')).ok
    ).toBe(false); // no claims
    expect(
      parsePlan(block('{"tasks":[{"title":"A","body":"x","claims":[".."]}]}'))
        .ok
    ).toBe(false); // only an invalid claim
    expect(parsePlan("STOA_PLAN_BEGIN\n{}").ok).toBe(false); // no END marker
  });
});

describe("buildPlannerPrompt", () => {
  it("contains the load-bearing instructions", () => {
    const p = buildPlannerPrompt({ base_branch: "main" }, "Build X", 8);
    expect(p).toContain("STOA_PLAN_BEGIN");
    expect(p).toContain("STOA_PLAN_END");
    expect(p).toContain("PATH PREFIXES");
    expect(p).toMatch(/disjoint/i);
    expect(p).toMatch(/do not commit/i);
    expect(p).toContain("Build X");
    expect(p).toContain("8");
  });
});
