import { detectAgentBinaries } from "@/lib/readiness-server";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/registry";
import { allocateFleetAgents } from "./allocation";
import {
  filterFleetUnattendedProviders,
  isFleetUnattendedProvider,
  type FleetUnattendedProviderId,
} from "./provider-eligibility";

export type FleetAgentProviderId = FleetUnattendedProviderId;

const INSTALLED_PROVIDER_CACHE_MS = 30_000;
let installedProviderCache:
  { checkedAt: number; providers: FleetAgentProviderId[] } | undefined;

/**
 * Resolve installed Fleet-capable agent CLIs in registry order. Keeping this
 * server-side probe in one place makes planner and auxiliary allocation use the
 * same definition of "installed" without relying on a shell or POSIX command.
 */
export function detectInstalledFleetAgentProviders(): FleetAgentProviderId[] {
  const now = Date.now();
  if (
    installedProviderCache &&
    now - installedProviderCache.checkedAt < INSTALLED_PROVIDER_CACHE_MS
  ) {
    return [...installedProviderCache.providers];
  }
  const found = detectAgentBinaries();
  const providers = filterFleetUnattendedProviders(
    PROVIDER_IDS.filter(
      (provider) => provider !== "shell" && Boolean(found[provider])
    )
  );
  installedProviderCache = { checkedAt: now, providers };
  return [...providers];
}

export interface FleetAuxiliaryProviderSelection {
  provider: FleetAgentProviderId;
  model: string | null;
}

/**
 * Choose an installed provider for a planner critic, code reviewer, or fixer.
 * The preferred provider wins when it is installed; otherwise the first
 * installed provider in registry order is the deterministic fallback. A model
 * is provider-owned, so it is carried only when the provider identity is
 * unchanged. This deliberately prevents (for example) a Hermes `kimi-k3`
 * model from leaking into a Codex fallback launch.
 */
export function allocateFleetAuxiliaryProvider(input: {
  availableProviders: readonly ProviderId[];
  preferredProvider: FleetAgentProviderId;
  preferredModel: string | null;
}): FleetAuxiliaryProviderSelection {
  const availableSet = new Set(input.availableProviders);
  const availableProviders = PROVIDER_IDS.filter(
    (provider): provider is FleetAgentProviderId =>
      availableSet.has(provider) && isFleetUnattendedProvider(provider)
  );
  const [selection] = allocateFleetAgents({
    tasks: [{ suggestedProvider: input.preferredProvider }],
    availableProviders,
    defaultProvider: input.preferredProvider,
    defaultModel: input.preferredModel,
  });
  if (selection.provider === "shell") {
    // allocateFleetAgents filters shell, but keep the public contract narrow if
    // its implementation changes later.
    throw new Error("no installed agent provider is available");
  }
  return { provider: selection.provider, model: selection.model };
}
