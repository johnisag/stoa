/**
 * Exponential backoff ceiling (ms) for the /ws/events reconnect loop, capped at
 * 30s. The caller applies jitter on top. `attempt` is 0-based, so the ceiling
 * grows 1s, 2s, 4s, 8s, … — instead of hammering a downed server every 3s
 * (which spams failed-connect console errors during a build/restart). Pure, so
 * the progression is unit-testable; jitter (Math.random) stays in the hook.
 */
export function reconnectBaseDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30000);
}
