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
];

describe("Fleet operator route security contract", () => {
  it.each(MUTATION_ROUTES)(
    "%s remains admin-only and parses a capped body",
    (route) => {
      const source = readFileSync(join(process.cwd(), route), "utf8");
      expect(source).toContain("const denied = requireAdmin(request)");
      expect(source).toContain("readCappedJsonBody(request");
      expect(source).not.toContain("await request.json()");
    }
  );
});
