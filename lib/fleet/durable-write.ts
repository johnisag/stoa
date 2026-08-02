import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { redactAndCapFleetText, redactFleetText } from "./redaction";
import { chargeFleetRuntimeUsageBatch } from "./resource-runtime";

const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_ACTOR_INPUT_BYTES = 4 * 1024;
const MAX_ACTOR_STORED_BYTES = 256;
const MAX_ARTIFACT_TITLE_INPUT_BYTES = 16 * 1024;
const MAX_ARTIFACT_TITLE_STORED_BYTES = 4 * 1024;
const MAX_ARTIFACT_METADATA_INPUT_BYTES = 256 * 1024;
const SAFE_DURABLE_KIND = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const CONTROL_PLANE_EVENT_TYPES = new Set([
  "automatic_merge_requested",
  "cancel_cleanup_pending",
  "cancel_cleanup_recovery_failed",
  "cleanup_action_completed",
  "cleanup_action_failed",
  "cleanup_action_skipped",
  "cleanup_requested",
  "destructive_cancel_authorized",
  "destructive_cancel_cleanup_failed",
  "auxiliary_interrupt_stop_confirmed",
  "fleet_merge_completed",
  "integration_pr_ready",
  "integration_reconcile_failed",
  "integration_workspace_cleaned",
  "integration_workspace_ready",
  "fleet_landing_retry_scheduled",
  "manual_final_verification_retry_requested",
  "manual_merge_landing_authorized",
  "manual_merge_requested",
  "manual_merge_staging_retry_requested",
  "run_archived",
  "run_canceled",
  "run_paused",
  "run_resumed",
  "run_status_reconcile_failed",
  "task_integration_failed",
  "worker_interrupt_stop_confirmed",
  "worker_started",
]);

function transaction<T>(db: Database.Database, fn: () => T): T {
  if (db.inTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function boundedRedactedText(
  value: string,
  field: string,
  maxInputBytes: number,
  maxStoredBytes: number
) {
  if (typeof value !== "string") {
    throw new Error(`Fleet durable ${field} must be text`);
  }
  const inputBytes = Buffer.byteLength(value, "utf8");
  if (inputBytes > maxInputBytes) {
    throw new Error(`Fleet durable ${field} exceeds ${maxInputBytes} bytes`);
  }
  return redactAndCapFleetText(value, maxStoredBytes);
}

function validateDurableKind(value: string, field: string): void {
  if (typeof value !== "string" || !SAFE_DURABLE_KIND.test(value)) {
    throw new Error(`Fleet durable ${field} is invalid`);
  }
}

export class FleetRuntimeQuotaExceededError extends Error {
  constructor(
    readonly runId: string,
    readonly resource:
      | "artifact_bytes_per_minute"
      | "artifact_bytes_total"
      | "event_bytes_per_minute"
      | "event_fanout_per_minute"
      | "event_bytes_total"
  ) {
    super(`Fleet ${resource} quota exceeded for run ${runId}`);
    this.name = "FleetRuntimeQuotaExceededError";
  }
}

export function prepareFleetArtifactBody(body: string): {
  body: string;
  byteCount: number;
  contentHash: string;
  replacementCount: number;
} {
  if (typeof body !== "string") {
    throw new Error("Fleet artifact body must be text");
  }
  const rawBytes = Buffer.byteLength(body, "utf8");
  if (rawBytes > MAX_ARTIFACT_BYTES) {
    throw new Error(`Fleet artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  const redacted = redactFleetText(body);
  return {
    body: redacted.text,
    byteCount: Buffer.byteLength(redacted.text, "utf8"),
    contentHash: createHash("sha256")
      .update(redacted.text, "utf8")
      .digest("hex"),
    replacementCount: redacted.replacementCount,
  };
}

function redactionMetadata(
  metadataJson: string | null | undefined,
  replacementCount: number
): string {
  let metadata: Record<string, unknown> = {};
  if (metadataJson) {
    try {
      const parsed = JSON.parse(metadataJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = { metadataInvalid: true };
    }
  }
  if (replacementCount > 0) {
    metadata = {
      ...metadata,
      fleetRedaction: { replacementCount },
    };
  }
  return JSON.stringify(metadata);
}

function sanitizeEventPayload(payload: string | null): string | null {
  if (payload == null) return null;
  if (typeof payload !== "string") {
    throw new Error("Fleet event payload must be text or null");
  }
  const rawBytes = Buffer.byteLength(payload, "utf8");
  if (rawBytes > MAX_EVENT_PAYLOAD_BYTES) {
    return JSON.stringify({
      omitted: true,
      reason: "payload_too_large",
      originalBytes: rawBytes,
    });
  }
  const redacted = redactFleetText(payload);
  let sanitized = redacted.text;
  if (redacted.replacementCount > 0) {
    try {
      const parsed = JSON.parse(sanitized);
      sanitized = JSON.stringify(
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? {
              ...(parsed as Record<string, unknown>),
              fleetRedaction: {
                replacementCount: redacted.replacementCount,
              },
            }
          : {
              value: parsed,
              fleetRedaction: {
                replacementCount: redacted.replacementCount,
              },
            }
      );
    } catch {
      sanitized = JSON.stringify({
        message: sanitized,
        fleetRedaction: { replacementCount: redacted.replacementCount },
      });
    }
  }
  const sanitizedBytes = Buffer.byteLength(sanitized, "utf8");
  if (sanitizedBytes <= MAX_EVENT_PAYLOAD_BYTES) return sanitized;
  return JSON.stringify({
    omitted: true,
    reason: "payload_too_large",
    originalBytes: rawBytes,
  });
}

export function insertFleetEvent(
  db: Database.Database,
  input: {
    runId: string;
    eventType: string;
    actor: string;
    payload: string | null;
    createdAt?: string;
    controlPlane?: boolean;
  }
): Database.RunResult {
  return transaction(db, () => {
    validateDurableKind(input.eventType, "event type");
    if (input.controlPlane && !CONTROL_PLANE_EVENT_TYPES.has(input.eventType)) {
      throw new Error("Fleet control-plane event type is not allowlisted");
    }
    const actor = boundedRedactedText(
      input.actor,
      "event actor",
      MAX_ACTOR_INPUT_BYTES,
      MAX_ACTOR_STORED_BYTES
    );
    const payload = sanitizeEventPayload(input.payload);
    const storedBytes =
      Buffer.byteLength(input.eventType, "utf8") +
      Buffer.byteLength(actor.text, "utf8") +
      Buffer.byteLength(payload ?? "", "utf8");
    if (!input.controlPlane) {
      const charged = chargeFleetRuntimeUsageBatch(db, {
        runId: input.runId,
        usage: [
          { kind: "event_fanout_per_minute", units: 1 },
          {
            kind: "event_bytes_per_minute",
            units: Math.max(1, storedBytes),
          },
          { kind: "event_bytes_total", units: Math.max(1, storedBytes) },
        ],
        now: input.createdAt ? new Date(input.createdAt) : new Date(),
      });
      if (!charged.admitted) {
        throw new FleetRuntimeQuotaExceededError(
          input.runId,
          charged.blocked.some(
            (blocked) => blocked.kind === "event_bytes_total"
          )
            ? "event_bytes_total"
            : charged.blocked.some(
                  (blocked) => blocked.kind === "event_bytes_per_minute"
                )
              ? "event_bytes_per_minute"
              : "event_fanout_per_minute"
        );
      }
    }
    return db
      .prepare(
        `INSERT INTO fleet_events
         (fleet_run_id, event_type, actor, payload, created_at)
         VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`
      )
      .run(
        input.runId,
        input.eventType,
        actor.text,
        payload,
        input.createdAt ?? null
      );
  });
}

export interface FleetArtifactWrite {
  id: string;
  runId: string;
  taskId?: string | null;
  workerId?: string | null;
  attempt?: number | null;
  planHash?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  contentHash?: string | null;
  metadataJson?: string | null;
  byteCount?: number;
  artifactType: string;
  title: string;
  body: string;
  severity: string;
  actor: string;
  createdAt?: string;
}

export function insertFleetArtifact(
  db: Database.Database,
  input: FleetArtifactWrite,
  options: { orIgnore?: boolean } = {}
): Database.RunResult {
  return transaction(db, () => {
    validateDurableKind(input.artifactType, "artifact type");
    validateDurableKind(input.severity, "artifact severity");
    if (options.orIgnore) {
      const existing = db
        .prepare(
          `SELECT 1 FROM fleet_artifacts
         WHERE id = ? OR (? IS NOT NULL AND ? IS NOT NULL AND
           worker_id = ? AND attempt = ? AND artifact_type = ?)
         LIMIT 1`
        )
        .get(
          input.id,
          input.workerId ?? null,
          input.attempt ?? null,
          input.workerId ?? null,
          input.attempt ?? null,
          input.artifactType
        );
      if (existing) {
        return db.prepare(`UPDATE fleet_artifacts SET id = id WHERE 0`).run();
      }
    }
    const title = boundedRedactedText(
      input.title,
      "artifact title",
      MAX_ARTIFACT_TITLE_INPUT_BYTES,
      MAX_ARTIFACT_TITLE_STORED_BYTES
    );
    const body = prepareFleetArtifactBody(input.body);
    const metadata = boundedRedactedText(
      input.metadataJson ?? "{}",
      "artifact metadata",
      MAX_ARTIFACT_METADATA_INPUT_BYTES,
      MAX_ARTIFACT_METADATA_INPUT_BYTES
    );
    const actor = boundedRedactedText(
      input.actor,
      "artifact actor",
      MAX_ACTOR_INPUT_BYTES,
      MAX_ACTOR_STORED_BYTES
    );
    const replacementCount =
      title.replacementCount +
      body.replacementCount +
      metadata.replacementCount +
      actor.replacementCount;
    const metadataJson = redactionMetadata(metadata.text, replacementCount);
    const actualBytes =
      Buffer.byteLength(title.text, "utf8") +
      body.byteCount +
      Buffer.byteLength(metadataJson, "utf8");
    if (actualBytes > MAX_ARTIFACT_BYTES) {
      throw new Error(`Fleet artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    }
    const charged = chargeFleetRuntimeUsageBatch(db, {
      runId: input.runId,
      usage: [
        {
          kind: "artifact_bytes_per_minute",
          units: Math.max(1, actualBytes),
        },
        { kind: "artifact_bytes_total", units: Math.max(1, actualBytes) },
      ],
      now: input.createdAt ? new Date(input.createdAt) : new Date(),
    });
    if (!charged.admitted) {
      throw new FleetRuntimeQuotaExceededError(
        input.runId,
        charged.blocked.some(
          (blocked) => blocked.kind === "artifact_bytes_total"
        )
          ? "artifact_bytes_total"
          : "artifact_bytes_per_minute"
      );
    }
    return db
      .prepare(
        `INSERT ${options.orIgnore ? "OR IGNORE " : ""}INTO fleet_artifacts
         (id, fleet_run_id, task_id, worker_id, attempt, plan_hash, base_sha,
          head_sha, content_hash, metadata_json, byte_count, artifact_type,
          title, body, severity, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 COALESCE(?, datetime('now')))`
      )
      .run(
        input.id,
        input.runId,
        input.taskId ?? null,
        input.workerId ?? null,
        input.attempt ?? null,
        input.planHash ?? null,
        input.baseSha ?? null,
        input.headSha ?? null,
        body.contentHash,
        metadataJson,
        body.byteCount,
        input.artifactType,
        title.text,
        body.body,
        input.severity,
        actor.text,
        input.createdAt ?? null
      );
  });
}
