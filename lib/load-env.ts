import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Dependency-free `.env` loader, shared so the server loads the same `.env` the
 * `stoa` CLI does. The CLI (scripts/stoa.js) hydrates process.env from `.env`,
 * but the keep-alive supervisor launches `node server.ts` directly (bypassing
 * the CLI), so editing the install's `.env` (e.g. flipping STOA_TRUST_TAILSCALE
 * or moving DB_PATH) wouldn't reach the running server. Loading it here makes
 * `.env` authoritative regardless of launcher. Mirrors the CLI parser exactly
 * (BOM strip, `export ` prefix, surrounding quotes) with "real env wins"
 * precedence — a value already in process.env is never overwritten.
 */

/** Parse `.env` text into a plain object. Pure (no I/O). */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = String(content).replace(/^﻿/, "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Read `<dir>/.env` and set any keys NOT already in process.env. Missing file or
 * read error is a silent no-op. STOA_SKIP_ENV_FILE=1 disables it (used by tests).
 * Returns the parsed object (for tests).
 */
export function loadEnvFile(dir: string): Record<string, string> {
  if (process.env.STOA_SKIP_ENV_FILE === "1") return {};
  const envPath = join(dir, ".env");
  if (!existsSync(envPath)) return {};
  let parsed: Record<string, string> = {};
  try {
    parsed = parseEnvFile(readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return parsed;
}
