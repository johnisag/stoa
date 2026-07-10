import { describe, expect, it } from "vitest";
import { fleetRunShouldPoll } from "@/data/fleet/queries";
import type {
  FleetRunDetailDto,
  FleetRunStatus,
  FleetWorkerStatus,
} from "@/lib/fleet/types";

function detail(
  status: FleetRunStatus,
  workerStatuses: FleetWorkerStatus[] = []
): FleetRunDetailDto {
  return {
    run: { status },
    workers: workerStatuses.map((workerStatus, index) => ({
      id: `worker-${index}`,
      status: workerStatus,
    })),
    tasks: [],
    artifacts: [],
    events: [],
  } as unknown as FleetRunDetailDto;
}

describe("fleetRunShouldPoll", () => {
  it("polls running runs", () => {
    expect(fleetRunShouldPoll(detail("running"))).toBe(true);
  });

  it("keeps polling paused runs while workers can still change", () => {
    expect(fleetRunShouldPoll(detail("paused", ["running"]))).toBe(true);
    expect(fleetRunShouldPoll(detail("paused", ["spawning"]))).toBe(true);
    expect(fleetRunShouldPoll(detail("paused", ["cleanup_pending"]))).toBe(
      true
    );
  });

  it("keeps polling canceled runs so late cleanup failures become visible", () => {
    expect(fleetRunShouldPoll(detail("canceled", ["cleanup_pending"]))).toBe(
      true
    );
    expect(fleetRunShouldPoll(detail("canceled", ["canceled"]))).toBe(true);
  });

  it("stops polling terminal or inactive views", () => {
    expect(fleetRunShouldPoll(undefined)).toBe(false);
    expect(fleetRunShouldPoll(detail("paused", ["completed"]))).toBe(false);
    expect(fleetRunShouldPoll(detail("planned", ["running"]))).toBe(false);
    expect(fleetRunShouldPoll(detail("completed", ["completed"]))).toBe(false);
  });
});
