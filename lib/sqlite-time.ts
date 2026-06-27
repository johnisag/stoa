/**
 * SQLite TEXT-datetime → epoch-ms, shared so the analytics layer and the watchdog
 * can't drift on the one subtlety that matters: `datetime('now')` yields
 * "YYYY-MM-DD HH:MM:SS" in UTC with NO zone suffix, so it must be parsed as UTC,
 * not the host's local zone (which would skew every age/duration by the UTC
 * offset). We swap the space for a "T" and append "Z" (so a bare value with
 * fractional seconds, "…00.123", still parses as UTC); a value that already
 * contains a "T" — a JS toISOString() form, which carries its own "Z" — is passed
 * through untouched. Pure → unit-tested. (Every writer today emits one of those
 * two forms; a hypothetical zone-less "T" value would fall to local time.)
 */
export function sqliteTimeToMs(
  value: string | null | undefined
): number | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
