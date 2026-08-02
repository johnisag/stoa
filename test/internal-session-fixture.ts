import { createHash } from "node:crypto";

/** Minimal role-bound profile for tests that exercise generic-route exclusion,
 * not managed-supervisor launch semantics. Production internal profiles use
 * their subsystem's exact versioned schema. */
export function internalSessionProfile(role: string): {
  profileJson: string;
  profileHash: string;
} {
  const profileJson = JSON.stringify({ role });
  return {
    profileJson,
    profileHash: createHash("sha256").update(profileJson, "utf8").digest("hex"),
  };
}
