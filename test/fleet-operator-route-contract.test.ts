import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const MUTATION_ROUTES = [
  "app/api/fleet/runs/[id]/tasks/[taskId]/retry/route.ts",
  "app/api/fleet/runs/[id]/tasks/[taskId]/verification/route.ts",
  "app/api/fleet/runs/[id]/tasks/[taskId]/review/route.ts",
  "app/api/fleet/runs/[id]/workers/[workerId]/message/route.ts",
  "app/api/fleet/runs/[id]/workers/[workerId]/kill/route.ts",
  "app/api/fleet/runs/[id]/merge/route.ts",
  "app/api/fleet/runs/[id]/controls/concurrency/route.ts",
  "app/api/fleet/runs/[id]/controls/budget/route.ts",
  "app/api/fleet/runs/[id]/tasks/[taskId]/controls/skip/route.ts",
  "app/api/fleet/runs/[id]/tasks/[taskId]/controls/read-only/route.ts",
  "app/api/fleet/runs/[id]/tasks/[taskId]/controls/manual-launch/route.ts",
  "app/api/fleet/runs/[id]/tasks/[taskId]/claims/approve/route.ts",
  "app/api/fleet/runs/[id]/archive/route.ts",
  "app/api/fleet/runs/[id]/cleanup/route.ts",
  "app/api/fleet/runs/[id]/cancel/route.ts",
  "app/api/fleet/runs/[id]/pause/route.ts",
  "app/api/fleet/runs/[id]/resume/route.ts",
];

const ADMIN_READ_ROUTES = [
  "app/api/fleet/runs/[id]/approvals/preview/route.ts",
];

describe("Fleet operator route security contract", () => {
  it.each(MUTATION_ROUTES)(
    "%s remains admin-only and parses a capped body",
    (route) => {
      const source = readFileSync(join(process.cwd(), route), "utf8");
      expect(source).toContain("const denied = requireAdmin(request)");
      expect(source).toMatch(/readCappedJsonBody\(\s*request/);
      expect(source).not.toContain("await request.json()");
    }
  );

  it.each(ADMIN_READ_ROUTES)("%s remains admin-only", (route) => {
    const source = readFileSync(join(process.cwd(), route), "utf8");
    expect(source).toContain("const denied = requireAdmin(request)");
  });

  it.each([
    "app/api/fleet/runs/[id]/archive/route.ts",
    "app/api/fleet/runs/[id]/cleanup/route.ts",
    "app/api/fleet/runs/[id]/cancel/route.ts",
    "app/api/fleet/runs/[id]/pause/route.ts",
    "app/api/fleet/runs/[id]/resume/route.ts",
  ])("%s binds audit identity at the authenticated route", (route) => {
    const source = readFileSync(join(process.cwd(), route), "utf8");
    expect(source).toContain('actor: "operator"');
  });
});
