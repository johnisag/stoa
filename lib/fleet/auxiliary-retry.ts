import type Database from "better-sqlite3";
import {
  looksLikeProviderRateLimit,
  recordFleetProviderCooldown,
} from "./resource-runtime";
import { fleetProviderRetryNotBefore } from "./backoff";

export const FLEET_AUXILIARY_LAUNCH_MAX_FAILURES = 3;

const TRANSIENT_LAUNCH_ERROR =
  /(?:timed?\s*out|temporar(?:y|ily)|service\s+unavailable|try\s+again|\bbusy\b|socket\s+hang\s+up|connection\s+(?:reset|refused|closed)|\bE(?:AI_AGAIN|CONNRESET|CONNREFUSED|TIMEDOUT|HOSTUNREACH|NETUNREACH)\b|backend\s+unavailable)/i;

export interface FleetAuxiliaryLaunchRetryDecision {
  failureCount: number;
  retry: boolean;
  retryNotBefore: string | null;
  providerRateLimited: boolean;
}

/**
 * Decide and durably coordinate a retry for a paid auxiliary-session launch.
 * Callers remain responsible for proving ownership and completing cleanup
 * before exposing the owner row as retryable.
 */
export function decideFleetAuxiliaryLaunchRetry(
  db: Database.Database,
  input: {
    provider: string;
    previousFailureCount: number;
    error: unknown;
    now: Date;
    safeToRetry: boolean;
  }
): FleetAuxiliaryLaunchRetryDecision {
  const previous = Number.isSafeInteger(input.previousFailureCount)
    ? Math.max(0, input.previousFailureCount)
    : 0;
  const failureCount = previous + 1;
  const providerRateLimited = looksLikeProviderRateLimit(input.error);
  const message =
    input.error instanceof Error ? input.error.message : String(input.error);
  const transient = providerRateLimited || TRANSIENT_LAUNCH_ERROR.test(message);
  const retry =
    input.safeToRetry &&
    transient &&
    failureCount < FLEET_AUXILIARY_LAUNCH_MAX_FAILURES;
  const cooldown = providerRateLimited
    ? recordFleetProviderCooldown(db, {
        provider: input.provider,
        reason: message,
        now: input.now,
      })
    : null;
  if (!retry) {
    return {
      failureCount,
      retry: false,
      retryNotBefore: null,
      providerRateLimited,
    };
  }

  let retryNotBefore = fleetProviderRetryNotBefore(input.now, failureCount);
  if (cooldown && cooldown > retryNotBefore) retryNotBefore = cooldown;
  return {
    failureCount,
    retry: true,
    retryNotBefore,
    providerRateLimited,
  };
}
