import { readFileSync } from "fs";
import { join } from "path";

/**
 * Parse a dotenv-style file body into key→value pairs. Pure (unit-testable):
 * skips blank lines and `#` comments, ignores lines without `=`, and strips a
 * single pair of matching surrounding quotes from the value.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// Side effect on import: load a cwd-relative `.env` into process.env so
// `npm run dev` (which runs `tsx server.ts` directly) honours `.env` the SAME
// way the `stoa` CLI does — the CLI loads `.env` then passes it to the spawned
// server, but `npm run dev` bypasses the CLI. Existing env vars win (an explicit
// variable overrides the file). MUST be the FIRST import in server.ts, before
// anything reads PORT / DB_PATH / STOA_PTY_HOST_NAME. Skipped under vitest (tests
// manage their own env) and via STOA_SKIP_ENV_FILE=1.
if (process.env.STOA_SKIP_ENV_FILE !== "1" && !process.env.VITEST) {
  try {
    const env = parseEnv(readFileSync(join(process.cwd(), ".env"), "utf-8"));
    for (const [k, v] of Object.entries(env)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    // No .env / unreadable — that's fine.
  }
}
