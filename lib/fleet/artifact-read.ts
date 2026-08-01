import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import type { FleetArtifactBodyDto } from "./types";

export const FLEET_ARTIFACT_READ_ID_MAX = 160;
export const FLEET_ARTIFACT_BODY_READ_MAX_BYTES = 4 * 1024 * 1024;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

interface FleetArtifactBodyRow {
  id: string;
  content_hash: string | null;
  byte_count: number;
  body: string;
  body_pruned_at: string | null;
}

export type FleetArtifactBodyReadResult =
  | { ok: true; artifact: FleetArtifactBodyDto }
  | { ok: false; error: string; status: number };

/** Read one exact artifact body on demand and fail closed on corrupt evidence. */
export function readFleetArtifactBody(
  input: { runId: string; artifactId: string },
  db: Database.Database = getDb()
): FleetArtifactBodyReadResult {
  if (
    !SAFE_ID.test(input.runId) ||
    !SAFE_ID.test(input.artifactId) ||
    input.runId.length > FLEET_ARTIFACT_READ_ID_MAX ||
    input.artifactId.length > FLEET_ARTIFACT_READ_ID_MAX
  ) {
    return { ok: false, error: "invalid Fleet artifact binding", status: 400 };
  }
  const row = db
    .prepare(
      `SELECT id, content_hash, byte_count, body, body_pruned_at
       FROM fleet_artifacts WHERE fleet_run_id = ? AND id = ?`
    )
    .get(input.runId, input.artifactId) as FleetArtifactBodyRow | undefined;
  if (!row) {
    return { ok: false, error: "Fleet artifact not found", status: 404 };
  }
  if (row.body_pruned_at) {
    return {
      ok: true,
      artifact: {
        id: row.id,
        contentHash: row.content_hash,
        byteCount: row.byte_count,
        body: "",
        bodyPrunedAt: row.body_pruned_at,
      },
    };
  }
  const actualBytes = Buffer.byteLength(row.body, "utf8");
  if (actualBytes > FLEET_ARTIFACT_BODY_READ_MAX_BYTES) {
    return {
      ok: false,
      error: "Fleet artifact body exceeds the safe read limit",
      status: 413,
    };
  }
  const actualHash = createHash("sha256")
    .update(row.body, "utf8")
    .digest("hex");
  // Artifacts created before the integrity columns existed have the migration
  // defaults (NULL/0). They remain readable, but the response clearly returns
  // a freshly computed binding rather than pretending the legacy row carried
  // immutable evidence it never stored.
  const legacyWithoutIntegrity =
    row.content_hash === null && row.byte_count === 0;
  if (
    !legacyWithoutIntegrity &&
    (row.byte_count !== actualBytes || row.content_hash !== actualHash)
  ) {
    return {
      ok: false,
      error: "Fleet artifact body failed its integrity check",
      status: 409,
    };
  }
  return {
    ok: true,
    artifact: {
      id: row.id,
      contentHash: legacyWithoutIntegrity ? actualHash : row.content_hash,
      byteCount: legacyWithoutIntegrity ? actualBytes : row.byte_count,
      body: row.body,
      bodyPrunedAt: null,
    },
  };
}
