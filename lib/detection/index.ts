/**
 * Agent state detection enhancements — confidence signals, transition
 * debouncing, and data-driven manifests. Inspired by Herdr's AgentDetection
 * struct, PendingIdleConfirmation logic, and TOML manifest system.
 *
 * These modules layer ON TOP of the existing status detector
 * (lib/status-detector.ts) without modifying it, so the core classification
 * logic stays untouched and the existing tests remain valid.
 */

export {
  deriveConfidence,
  NO_CONFIDENCE,
  type StatusConfidence,
} from "./confidence";

export {
  shouldHoldWorkingToIdle,
  isInStartupGrace,
  createDebounceState,
  DEBOUNCE_CONFIG,
  type DebounceState,
} from "./debounce";

export {
  getManifest,
  loadManifest,
  reloadManifests,
  validateManifest,
  userManifestDir,
  bundledManifestDir,
  type AgentManifest,
  type CompiledManifest,
} from "./manifests";
