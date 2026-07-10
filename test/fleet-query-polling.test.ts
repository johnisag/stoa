import { describe, expect, it } from "vitest";
import { fleetRunShouldPoll } from "@/data/fleet/queries";
import type {
  FleetRunDetailDto,
  FleetRunStatus,
  FleetWorkerStatus,
} from "@/lib/fleet/types";

function detail(
  status: FleetRunStatus,
  workerStatuses: FleetWorkerStatus[] = [],
  pendingLaunches = 0
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
    pendingLaunches,
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

  it("polls canceled runs only while a launch can still settle", () => {
    expect(fleetRunShouldPoll(detail("canceled", ["canceled"], 1))).toBe(true);
    expect(fleetRunShouldPoll(detail("canceled", ["cleanup_pending"], 1))).toBe(
      true
    );
  });

  it("stops polling terminal or inactive views", () => {
    expect(fleetRunShouldPoll(undefined)).toBe(false);
    expect(fleetRunShouldPoll(detail("paused", ["completed"]))).toBe(false);
    expect(fleetRunShouldPoll(detail("planned", ["running"]))).toBe(false);
    expect(fleetRunShouldPoll(detail("canceled", ["canceled"]))).toBe(false);
    expect(fleetRunShouldPoll(detail("canceled", ["cleanup_pending"]))).toBe(
      false
    );
    expect(fleetRunShouldPoll(detail("completed", ["completed"]))).toBe(false);
  });
});
