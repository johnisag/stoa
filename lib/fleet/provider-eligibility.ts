import {
  getProviderDefinition,
  isValidProviderId,
  type ProviderId,
} from "@/lib/providers/registry";

export type FleetUnattendedProviderId = Exclude<ProviderId, "shell">;

/**
 * Fleet sessions must be able to run without waiting in a provider TUI for
 * permission prompts. The provider registry's verified auto-approve flag is
 * the single capability boundary for that contract.
 *
 * A provider can remain fully available to interactive Stoa sessions while it
 * is excluded here. In particular, Kilo's bare TUI has no verified unattended
 * mode; its `--auto` flag belongs to a different `kilo run` command surface.
 */
export function isFleetUnattendedProvider(
  provider: string
): provider is FleetUnattendedProviderId {
  if (!isValidProviderId(provider) || provider === "shell") return false;
  const flag = getProviderDefinition(provider).autoApproveFlag;
  return typeof flag === "string" && flag.trim().length > 0;
}

/** Input-order-stable, duplicate-free Fleet provider filtering. */
export function filterFleetUnattendedProviders(
  providers: readonly ProviderId[]
): FleetUnattendedProviderId[] {
  return [...new Set(providers)].filter(isFleetUnattendedProvider);
}
