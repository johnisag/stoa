// React-query cache keys for saved visual-builder workflows. Mirrors data/pipelines/keys.ts.
export const savedWorkflowKeys = {
  all: ["saved-workflows"] as const,
  list: () => [...savedWorkflowKeys.all, "list"] as const,
  detail: (id: string) => [...savedWorkflowKeys.all, "detail", id] as const,
};
