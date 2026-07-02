/**
 * Agent pipelines — start a run (server-side glue).
 *
 * Validates a spec, verifies the conductor is a real Stoa session, then kicks
 * off the executor loop in the background, streaming each state snapshot into
 * the in-memory registry. Returns the INITIAL run immediately so the caller
 * (API/MCP) can hand back a run id to poll.
 *
 * This is the thin seam between the pure engine/executor and the real Stoa
 * world (DB + spawnWorker via defaultExecutorDeps). Kept out of executor.ts so
 * that module stays fake-injectable in tests.
 */

import { randomUUID } from "crypto";
import { db, queries, type Session } from "../db";
import { runInBackground } from "../async-operations";
import { validateSpec, initRun } from "./engine";
import { runPipeline, formatValidationErrors } from "./executor";
import { defaultExecutorDeps } from "./default-deps";
import { putRun } from "./registry";
import type { PipelineSpec, PipelineRun } from "./types";

export interface StartPipelineResult {
  run: PipelineRun;
}

/**
 * A client-caused failure (invalid spec / unknown conductor). The API layer
 * maps this to a 400; any other thrown error is a 500. Avoids brittle
 * message-prefix matching at the route.
 */
export class PipelineRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineRequestError";
  }
}

/**
 * Validate + launch a pipeline. Throws PipelineRequestError on an invalid spec
 * or unknown conductor (the caller maps these to a 400). The run executes in
 * the background; poll the registry by the returned run id for progress.
 */
export function startPipeline(
  spec: PipelineSpec,
  conductorSessionId: string
): StartPipelineResult {
  const validation = validateSpec(spec);
  if (!validation.valid) {
    throw new PipelineRequestError(formatValidationErrors(validation.errors));
  }

  const conductor = queries.getSession(db).get(conductorSessionId) as
    Session | undefined;
  if (!conductor) {
    throw new PipelineRequestError(
      `Unknown conductor session: ${conductorSessionId}. The conductor must be an existing Stoa session.`
    );
  }

  // Pre-register the run under a known id so a poll right after start sees it,
  // and so the background executor writes under the SAME id.
  const runId = randomUUID();
  const initial = initRun(spec, { id: runId, now: Date.now() });
  putRun(initial);

  const deps = defaultExecutorDeps(conductorSessionId);
  runInBackground(async () => {
    await runPipeline(
      spec,
      { ...deps, onUpdate: (r) => putRun(r) },
      { runId, preValidated: true }
    );
  }, `pipeline-run-${runId}`);

  return { run: initial };
}
