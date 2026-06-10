// React-query cache keys for the Dispatch control plane. Mirrors the shape of
// data/sessions/keys.ts.
export const dispatchKeys = {
  all: ["dispatch"] as const,
  repos: () => [...dispatchKeys.all, "repos"] as const,
  pending: () => [...dispatchKeys.all, "pending"] as const, // review queue (backlog)
  board: () => [...dispatchKeys.all, "board"] as const, // in-flight + finished
  discover: () => [...dispatchKeys.all, "discover"] as const, // scanned local repos
  github: () => [...dispatchKeys.all, "github"] as const, // gh repo list
  scheduled: () => [...dispatchKeys.all, "scheduled"] as const, // future-dated rows
  openIssues: (repoId: string) =>
    [...dispatchKeys.all, "open-issues", repoId] as const, // on-demand gh issue browse (triage)
  plan: (planId: string) => [...dispatchKeys.all, "plan", planId] as const, // a planner run's poll
};
