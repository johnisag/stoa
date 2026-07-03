/**
 * OS-level sandbox launch tier (#27) — public surface. See ./types for the
 * tri-state model and ./wrap for the additive, fail-safe argv transform.
 */

export type {
  ApprovalMode,
  SandboxPolicy,
  SandboxTool,
  SandboxWrap,
} from "./types";
// coerceApprovalMode lives in ./types (pure, client-safe); re-export for server
// callers that already import the wrap/detect surface from here.
export { coerceApprovalMode } from "./types";
export { detectSandboxTool, type DetectedSandbox } from "./detect";
export { computeRwRoots, type RwRootsInput } from "./policy";
export { wrapSpawnForSandbox, type WrapDeps } from "./wrap";
