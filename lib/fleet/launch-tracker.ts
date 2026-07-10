interface FleetLaunchTrackerState {
  pendingByRun: Map<string, number>;
}

// API route bundles and hot reloads must observe one process-wide launch count.
const globalLaunchTracker = globalThis as typeof globalThis & {
  __stoaFleetLaunchTracker?: FleetLaunchTrackerState;
};

function trackerState(): FleetLaunchTrackerState {
  globalLaunchTracker.__stoaFleetLaunchTracker ??= {
    pendingByRun: new Map<string, number>(),
  };
  return globalLaunchTracker.__stoaFleetLaunchTracker;
}

export function pendingFleetLaunchCount(runId: string): number {
  return trackerState().pendingByRun.get(runId) ?? 0;
}

export function trackFleetLaunch<T>(
  runId: string,
  launch: Promise<T>
): Promise<T> {
  const pendingByRun = trackerState().pendingByRun;
  pendingByRun.set(runId, (pendingByRun.get(runId) ?? 0) + 1);
  return launch.finally(() => {
    const remaining = (pendingByRun.get(runId) ?? 1) - 1;
    if (remaining > 0) pendingByRun.set(runId, remaining);
    else pendingByRun.delete(runId);
  });
}
