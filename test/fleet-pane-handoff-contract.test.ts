import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Pane Fleet Board handoff contract", () => {
  it("wires exact run/task selection without exposing generic Fleet terminal attachment", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "components", "Pane", "index.tsx"),
      "utf8"
    );
    expect(source).toContain("onOpenFleetRun={handleOpenFleetRun}");
    expect(source).toContain("initialRunId={fleetSelection?.runId}");
    expect(source).toContain("initialTaskId={fleetSelection?.taskId}");
    expect(source).toContain("selectionKey={fleetSelection?.requestKey}");
    const fleetManagementCase = source.slice(
      source.indexOf('case "fleet-management":'),
      source.indexOf('case "analytics":')
    );
    expect(fleetManagementCase).not.toContain("onOpenSession=");
  });
});
