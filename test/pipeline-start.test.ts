/**
 * startPipeline — validates + launches a run, mocking the DB (conductor lookup),
 * the background runner (so the executor doesn't actually run), and the
 * registry. Locks the request-error contract (invalid spec / unknown conductor
 * → PipelineRequestError) and that a valid call pre-registers the initial run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ conductorExists: true }));
const putRunMock = vi.hoisted(() => vi.fn());
const runInBackgroundMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
  db: {},
  queries: {
    getSession: () => ({
      get: (_id: string) =>
        state.conductorExists ? { id: "conductor-1" } : undefined,
    }),
  },
}));
vi.mock("@/lib/async-operations", () => ({
  runInBackground: runInBackgroundMock,
}));
vi.mock("@/lib/pipeline/registry", () => ({ putRun: putRunMock }));
vi.mock("@/lib/pipeline/default-deps", () => ({
  defaultExecutorDeps: () => ({}),
}));

import { startPipeline, PipelineRequestError } from "@/lib/pipeline/start";
import type { PipelineSpec } from "@/lib/pipeline/types";

const validSpec: PipelineSpec = {
  name: "p",
  workingDirectory: "/repo",
  steps: [{ id: "a", agent: "claude", task: "do it" }],
};

beforeEach(() => {
  state.conductorExists = true;
  putRunMock.mockClear();
  runInBackgroundMock.mockClear();
});

describe("startPipeline", () => {
  it("throws PipelineRequestError on an invalid spec (and never launches)", () => {
    expect(() =>
      startPipeline({ ...validSpec, steps: [] }, "conductor-1")
    ).toThrow(PipelineRequestError);
    expect(runInBackgroundMock).not.toHaveBeenCalled();
    expect(putRunMock).not.toHaveBeenCalled();
  });

  it("throws PipelineRequestError on an unknown conductor", () => {
    state.conductorExists = false;
    expect(() => startPipeline(validSpec, "ghost")).toThrow(
      /Unknown conductor session/
    );
    expect(runInBackgroundMock).not.toHaveBeenCalled();
  });

  it("pre-registers the initial run and schedules the background executor", () => {
    const { run } = startPipeline(validSpec, "conductor-1");
    expect(run.id).toBeTruthy();
    expect(run.status).toBe("pending");
    expect(run.steps.a.status).toBe("pending");
    // Seeded into the registry under the returned id.
    expect(putRunMock).toHaveBeenCalledTimes(1);
    expect(putRunMock.mock.calls[0][0].id).toBe(run.id);
    // Background executor scheduled exactly once.
    expect(runInBackgroundMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a spec whose model carries a shell-injection payload", () => {
    const evil: PipelineSpec = {
      ...validSpec,
      steps: [{ id: "a", agent: "hermes", task: "x", model: "$(rm -rf /)" }],
    };
    expect(() => startPipeline(evil, "conductor-1")).toThrow(
      PipelineRequestError
    );
  });
});
