import {
  spawnFleetWorker,
  type FleetSpawnInput,
  type FleetSpawnResult,
} from "./spawn";

/**
 * Optional execution seam for a future remote/cloud Fleet worker launcher.
 * The default remains the existing local spawn path, which owns the
 * SessionBackend/PtyTransport integration.
 */
export interface FleetWorkerExecutor {
  id: string;
  supports(input: FleetSpawnInput): boolean | Promise<boolean>;
  spawn(input: FleetSpawnInput): Promise<FleetSpawnResult>;
}

export const localFleetWorkerExecutor: FleetWorkerExecutor = {
  id: "local-session",
  supports: () => true,
  spawn: spawnFleetWorker,
};

export async function executeFleetWorker(
  input: FleetSpawnInput,
  optionalExecutor?: FleetWorkerExecutor | null,
  localExecutor: FleetWorkerExecutor = localFleetWorkerExecutor
): Promise<FleetSpawnResult> {
  if (
    optionalExecutor &&
    optionalExecutor !== localExecutor &&
    (await optionalExecutor.supports(input))
  ) {
    return optionalExecutor.spawn(input);
  }
  return localExecutor.spawn(input);
}
