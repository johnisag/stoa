import type { ProviderId } from "@/lib/providers/registry";
import { resolveExactModelForAgent } from "@/lib/model-catalog";
import {
  filterFleetUnattendedProviders,
  type FleetUnattendedProviderId,
} from "./provider-eligibility";

export interface FleetAllocationTask {
  suggestedProvider?: string | null;
  suggestedModel?: string | null;
}

export interface FleetTaskAllocation {
  provider: ProviderId;
  model: string | null;
}

/**
 * Assign each task to an available provider. Valid planner suggestions are
 * honored; everything else is balanced deterministically in registry order.
 * A run-level model is only portable to the run's own provider.
 */
export function allocateFleetAgents(input: {
  tasks: FleetAllocationTask[];
  availableProviders: ProviderId[];
  defaultProvider: ProviderId;
  defaultModel: string | null;
}): FleetTaskAllocation[] {
  const available = filterFleetUnattendedProviders(input.availableProviders);
  if (available.length === 0) {
    throw new Error("no installed agent provider is available");
  }

  const fallback = available.includes(
    input.defaultProvider as FleetUnattendedProviderId
  )
    ? (input.defaultProvider as FleetUnattendedProviderId)
    : available[0];
  const counts = new Map<ProviderId, number>(
    available.map((provider) => [provider, 0])
  );

  return input.tasks.map((task) => {
    const suggested = available.find(
      (provider) => provider === task.suggestedProvider
    );
    const provider =
      suggested ??
      available.reduce((best, candidate) => {
        const candidateCount = counts.get(candidate) ?? 0;
        const bestCount = counts.get(best) ?? 0;
        return candidateCount < bestCount ? candidate : best;
      }, fallback);
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
    const modelCandidate =
      task.suggestedModel != null &&
      (!task.suggestedProvider || task.suggestedProvider === provider)
        ? task.suggestedModel
        : provider === input.defaultProvider
          ? input.defaultModel
          : null;
    const resolved = resolveExactModelForAgent(provider, modelCandidate);
    if (!resolved.ok) {
      throw new Error(`${provider} allocation ${resolved.error}`);
    }
    return {
      provider,
      model: resolved.model,
    };
  });
}
