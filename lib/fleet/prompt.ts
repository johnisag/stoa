import type { FleetRunRow, FleetTaskRow } from "./types";

export function buildFleetWorkerPrompt(input: {
  run: FleetRunRow;
  task: FleetTaskRow;
  claims: string[];
  dependencies: string[];
  attempt: number;
  spawnRequestId: string;
}): string {
  const { run, task, claims, dependencies, attempt, spawnRequestId } = input;
  return `You are a worker in the Stoa fleet "${run.name}".

Fleet goal: ${run.goal}
Task: ${task.id} — ${task.title}
Description: ${task.description ?? "No additional description."}
Attempt: ${attempt}
Spawn request: ${spawnRequestId}
Acceptance criteria: ${task.acceptance_criteria ?? "Complete the task as described and keep the change surgical."}
Allowed file claims: ${claims.length ? claims.join(", ") : "none (read-only task)"}
Forbidden paths: ${claims.length ? "every path outside the allowed file claims" : "all repository writes"}
Dependencies: ${dependencies.length ? dependencies.join("; ") : "none"}
Verification command: ${task.verify_command ?? "Use the repository's required verification gate."}

Other agents may be editing nearby code. Do not modify paths outside your claims and do not revert unrelated changes. If a blocker requires a guess, stop and ask the operator. Do not merge or clean up worktrees.

When finished, submit this exact report shape in your final response:

# Fleet Task Completion Report
Task: ${task.id}
Attempt: ${attempt}
Spawn request: ${spawnRequestId}
Status: succeeded | blocked | failed

## Summary
## Files changed
## Verification
- Command:
- Result:
- Evidence:
## Risks
## Follow-ups
## Merge readiness
ready | not-ready

Leave this report visible in the terminal. The operator will mark the worker complete after reviewing it.`;
}
