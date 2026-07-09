import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const browserFleetFiles = [
  "components/views/FleetManagementView/index.tsx",
  "data/fleet/queries.ts",
  "data/fleet/keys.ts",
  "lib/fleet/engine.ts",
];

describe("Fleet Management browser boundary", () => {
  it("does not import server-only modules from browser-facing files", () => {
    const forbidden = [
      /from ["']@\/lib\/db(?:["'/])/,
      /from ["']@\/lib\/platform(?:["'/])/,
      /from ["']@\/lib\/fleet\/service(?:["'])/,
      /from ["']better-sqlite3["']/,
      /from ["'](?:node:)?fs["']/,
      /from ["'](?:node:)?path["']/,
      /from ["'](?:node:)?crypto["']/,
      /from ["'](?:node:)?child_process["']/,
    ];

    for (const file of browserFleetFiles) {
      const source = read(file);
      for (const pattern of forbidden) {
        expect(source, `${file} should not match ${pattern}`).not.toMatch(
          pattern
        );
      }
    }
  });

  it("imports Fleet DTOs as types only", () => {
    const source = read("data/fleet/queries.ts");
    expect(source).toMatch(
      /import type \{[\s\S]*\} from "@\/lib\/fleet\/types";/
    );
  });
});
