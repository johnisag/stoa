import type { FleetRunRow, FleetTaskRow } from "./types";

function fleetTaskRiskNotes(task: FleetTaskRow): unknown[] {
  try {
    const parsed = JSON.parse(task.risk_notes_json ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface FleetWorkerReportPromptContract {
  reportPath: string;
  nonce: string;
  baseSha: string;
  workerId: string;
}

export function buildFleetWorkerPrompt(input: {
  run: FleetRunRow;
  task: FleetTaskRow;
  claims: string[];
  dependencies: string[];
  attempt: number;
  spawnRequestId: string;
  reportContract?: FleetWorkerReportPromptContract;
}): string {
  const {
    run,
    task,
    claims,
    dependencies,
    attempt,
    spawnRequestId,
    reportContract,
  } = input;
  const common = `You are a worker in the Stoa fleet "${run.name}".

Fleet goal: ${run.goal}
Task: ${task.id} — ${task.title}
Description: ${task.description ?? "No additional description."}
Attempt: ${attempt}
Spawn request: ${spawnRequestId}
Acceptance criteria: ${task.acceptance_criteria ?? "Complete the task as described and keep the change surgical."}
Planned risk notes: ${JSON.stringify(fleetTaskRiskNotes(task))}
Allowed file claims: ${claims.length ? claims.join(", ") : "none (read-only task)"}
Forbidden paths: ${claims.length ? "every path outside the allowed file claims" : "all repository writes"}
Dependencies: ${dependencies.length ? dependencies.join("; ") : "none"}
Verification command: ${task.verify_command ?? "Use the repository's required verification gate."}

Other agents may be editing nearby code. Do not modify paths outside your claims and do not revert unrelated changes. If a blocker requires a guess, stop and report it. Do not merge, rebase, push, or clean up worktrees.`;

  if (!reportContract) {
    return `${common}

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

Leave this report visible in the terminal. The operator can use manual completion as a fallback.`;
  }

  const reportTemplate = {
    schemaVersion: 1,
    runId: run.id,
    taskId: task.id,
    workerId: reportContract.workerId,
    attempt,
    spawnRequestId,
    nonce: reportContract.nonce,
    baseSha: reportContract.baseSha,
    headSha: "<full committed HEAD SHA>",
    submittedAt: "<current ISO-8601 timestamp>",
    status: "succeeded | blocked | failed",
    summary: "<bounded summary>",
    filesChanged: ["<repository-relative committed path>"],
    verification: [
      {
        command: "<command>",
        result: "pass | fail | not_run",
        evidence: "<bounded evidence>",
      },
    ],
    risks: ["<risk>"],
    followUps: ["<follow-up>"],
    mergeReadiness: "ready | not_ready",
    markdown: "<optional bounded detail>",
  };

  return `${common}

This attempt uses an authenticated machine-readable completion report. Your worker ID is supplied by Stoa below. Commit every intended repository change before reporting and leave the worktree clean. The report headSha and filesChanged must exactly match Git. A read-only task must not create a commit.

Worker ID: ${reportContract.workerId}
Base SHA: ${reportContract.baseSha}
Exact report path: ${reportContract.reportPath}

Write the following JSON object exactly once to that report path when you are finished. Replace the angle-bracket placeholders with real values and preserve the supplied identity and nonce. Do not write the nonce anywhere else.

${JSON.stringify(reportTemplate, null, 2)}

After writing the report, leave it in place and wait. Stoa will independently inspect Git, collect the report, and stop this session.`;
}
