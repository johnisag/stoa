/**
 * Conflict-aware decomposition — the pure file-ownership claim model.
 *
 * A "claim" is a repo-relative PATH PREFIX a planned task exclusively owns (a
 * directory like `lib/dispatch/` or an exact file like `lib/db/schema.ts`). Two
 * tasks may run in parallel iff their claims are disjoint; the reconciler refuses to
 * co-schedule overlapping claims (they serialize instead of opening two PRs that
 * collide at merge).
 *
 * STRING-ONLY, no node builtins — so the overlap UI (PlanConsole) can import it on
 * the CLIENT (the lib/path-display.ts vs lib/platform.ts discipline). This is the
 * ONE place separators are handled (folds `\` → `/`), satisfying AGENTS.md's
 * "never split('/') a path" by centralizing it.
 *
 * Conservative by design: a shared parent dir counts as a conflict even if the exact
 * files differ. A false overlap merely serializes (safe); a MISSED overlap = two
 * conflicting open PRs (the failure to avoid). Pure → unit-tested.
 */

/**
 * Normalize a raw claim into a canonical repo-relative prefix, or null if invalid.
 * Folds `\`→`/`, collapses duplicate slashes, strips trailing slashes, and
 * canonicalizes `.` segments. Rejects (→ null) anything that could escape the
 * repo: an empty/blank claim, a `..` segment, a `~` home ref, or an absolute
 * drive-letter / POSIX / UNC path.
 */
export function normalizeClaim(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let c = raw.trim();
  if (!c) return null;
  c = c.replace(/\\/g, "/"); // the ONE separator-folding site
  if (/^[a-z]:/i.test(c) || c.startsWith("/") || c.startsWith("~")) {
    return null; // drive-letter / POSIX / UNC / home absolute — could escape the repo
  }
  c = c.replace(/\/{2,}/g, "/").replace(/\/+$/, ""); // dup + trailing slashes
  if (c.startsWith("/")) return null;
  if (!c) return null;
  const segments: string[] = [];
  for (const seg of c.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") return null; // no parent escapes
    segments.push(seg);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

/** Parse a stored file_claims JSON string into normalized, de-duped claims. Defensive
 * (junk / non-array / null → []). The inverse of serializeClaims. */
export function parseClaims(json: string | null | undefined): string[] {
  if (!json) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const raw of arr) {
    const c = normalizeClaim(raw);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** Serialize claims for storage (normalized + de-duped first). */
export function serializeClaims(claims: string[]): string {
  const out: string[] = [];
  for (const raw of claims) {
    const c = normalizeClaim(raw);
    if (c && !out.includes(c)) out.push(c);
  }
  return JSON.stringify(out);
}

/**
 * Do two single claims overlap? True iff they're equal or one is a path-PREFIX of
 * the other at a SEGMENT boundary. The appended "/" is what makes `lib/dispatch`
 * overlap `lib/dispatch/foo.ts` (and `lib` overlap everything under it) WITHOUT
 * falsely overlapping `lib/dispatchX`. Pure.
 */
export function claimsOverlap(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return true;
  return (
    (right + "/").startsWith(left + "/") || (left + "/").startsWith(right + "/")
  );
}

/** Do two claim SETS conflict? True iff any claim on one side overlaps any on the
 * other. EMPTY on either side ⇒ false — a no-claims row never conflicts (preserves
 * today's behavior for every legacy/non-planned row). Pure. */
export function claimsConflict(claimsA: string[], claimsB: string[]): boolean {
  return claimsA.some((a) => claimsB.some((b) => claimsOverlap(a, b)));
}
