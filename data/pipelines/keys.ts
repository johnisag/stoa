// React-query cache keys for the Workflows (agent-pipeline) view. Mirrors the
// shape of data/dispatch/keys.ts.
export const pipelineKeys = {
  all: ["pipelines"] as const,
  list: () => [...pipelineKeys.all, "list"] as const,
  detail: (id: string) => [...pipelineKeys.all, "detail", id] as const,
};
