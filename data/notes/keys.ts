// React-query cache keys for the shared knowledge-base notes. Mirrors
// data/saved-workflows/keys.ts.
export const noteKeys = {
  all: ["notes"] as const,
  list: () => [...noteKeys.all, "list"] as const,
};
