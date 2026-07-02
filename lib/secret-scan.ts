/**
 * Secrets guard (#36) — pure NAME-based classification of secret-bearing files
 * for the New Session working-directory warning.
 *
 * Deliberately dependency-free (no node builtins) so both the API route and
 * client components can import it. Matching is strictly by file NAME — no file
 * is ever opened. `.npmrc` matches by name alone (grepping its contents for an
 * authToken would mean reading the file, which this guard never does).
 *
 * Decision, locked by test/secret-scan.test.ts: `.envrc` does NOT match. It is
 * direnv *code* (layout/use directives), not a dotenv secrets file — matching
 * it would fire the warning on every direnv-using repo, and secrets it exports
 * typically live in a matched `.env*` file anyway.
 */

/** Case-insensitive name matchers (names are lowercased before testing). */
export const SECRET_FILE_PATTERNS: ReadonlyArray<{
  id: string;
  matches: (lowerName: string) => boolean;
}> = [
  // dotenv files: `.env` plus `.env.local`, `.env.production`, ...
  { id: "dotenv", matches: (n) => n === ".env" || n.startsWith(".env.") },
  // PEM-encoded keys/certs, plus the generic `.key` private-key extension
  // (TLS keys, service keys). `.pub` never matches — it's the public half.
  { id: "pem", matches: (n) => n.endsWith(".pem") || n.endsWith(".key") },
  // Default-named SSH private keys, all four algorithms (their `.pub` halves
  // are public — no match).
  {
    id: "ssh-key",
    matches: (n) =>
      n === "id_rsa" ||
      n === "id_ed25519" ||
      n === "id_ecdsa" ||
      n === "id_dsa",
  },
  // gcloud / service-account style credentials
  { id: "credentials", matches: (n) => n === "credentials.json" },
  // npm auth config (may hold an authToken — name match only, never read)
  { id: "npmrc", matches: (n) => n === ".npmrc" },
];

/** Upper bound on reported names — the warning is a hint, not an inventory. */
export const MAX_SECRET_FINDINGS = 10;

/**
 * Classify a directory's entry names (top level only — the caller does ONE
 * shallow readdir) and return the secret-looking ones, ordered alphabetically
 * (case-insensitive, locale-independent) and capped at MAX_SECRET_FINDINGS.
 * Matching is case-insensitive (Windows/macOS filesystems are), but the
 * ORIGINAL names are returned so the warning shows what's actually on disk.
 */
export function classifySecretFiles(names: string[]): string[] {
  const matched: string[] = [];
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) continue;
    const lower = name.toLowerCase();
    if (SECRET_FILE_PATTERNS.some((p) => p.matches(lower))) {
      matched.push(name);
    }
  }
  matched.sort((a, b) => {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  return matched.slice(0, MAX_SECRET_FINDINGS);
}
