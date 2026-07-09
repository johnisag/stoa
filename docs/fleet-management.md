# Fleet Management Plan

Last updated: 2026-07-08

## Executive summary

Stoa already has the ingredients for multi-agent work: MCP orchestration tools,
worker sessions in isolated worktrees, declarative DAG pipelines, dispatch
planning, a fleet board, fleet memory, review/verify/merge helpers, cost
tracking, and status detection. What it does not yet have is a durable
"manage 40 agents against one project plan" control plane.

The right architecture is not "ask one Claude or Codex conductor to remember
40 workers in its context." The conductor pattern is valuable, but at 40 agents
it should become a supervisor input to a server-owned scheduler. Stoa should own
the durable plan, task graph, worker lifecycle, concurrency limits, cost budget,
status aggregation, artifact contract, review gates, and merge queue. Agents
should execute bounded tasks and submit structured reports.

The implementation path should extend existing Stoa systems rather than replace
them:

- Reuse MCP orchestration for worker control and operator affordances.
- Reuse `spawnWorker` and `SessionBackend` for provider-neutral execution.
- Reuse pipeline engine concepts for DAG validation and scheduling decisions.
- Reuse dispatch planner claims for file-conflict avoidance.
- Reuse Fleet Board/Verdict Inbox concepts for lifecycle UI and attention.
- Reuse review, verify, and merge-train primitives for landing work.

Adversarial review correction: Fleet Management v1 must be a durable grouping
and control layer over existing Stoa fleet substrate, not a parallel product
that reimplements Dispatch, Pipelines, Verdict Inbox, Fleet Board, verification,
or merge. New tables and APIs are justified only where the existing model lacks
run-level grouping, leases, budget reservations, fleet-specific artifacts, and
operator approval state.

## Execution contract: run the phase loop to completion

This document is not only a design note. It is the operating contract for the
Fleet Management campaign.

The loop runs until every phase in the state ledger is completed. Do not exit
the campaign early because one phase merged, because context compressed, or
because a subtask became difficult. The only successful exit condition is:

- every phase is marked `Completed`,
- every active phase or slice branch has been merged, and every superseded or
  canceled branch is explicitly accounted for in the ledger,
- CI is green for the merged state,
- the local gate is green,
- the four-agent review gate is clean,
- this document's state ledger reflects the final truth,
- and no phase row has pending post-merge reconciliation.

Per-phase loop:

1. Start from fresh `main`.
2. Create a new branch for the phase.
3. Review the target phase and revise/generate a phase-specific implementation
   plan.
4. Split the phase into PR-sized slices if the phase is too large to review
   safely.
5. Implement with maximum safe parallelism.
6. Run the local gate: `npx tsc --noEmit`, `npm test`, `npm run build`.
7. Run the repo-required four-agent review gate:
   - correctness/security,
   - conventions/cross-platform,
   - simplicity/UX,
   - adversarial red-team.
8. Fix blocking/major findings.
9. Re-run verification and review until clean.
10. Update this plan's state ledger on the phase branch with pre-merge truth:
    gate evidence, review round, intended PR/slice status, blockers, follow-ups,
    and any post-merge fields that are expected to be filled later.
11. Commit with the required trailer.
12. Stop unless the operator has explicitly authorized pushing this phase or
    slice branch.
13. Push the branch only after that authorization.
14. Stop unless the operator has explicitly authorized PR creation for this
    pushed branch.
15. Open a PR only after that authorization.
16. Before final CI/merge approval, refresh/rebase against current `main` and
    reconcile this ledger against the current ledger in `main`; do not merge a
    stale ledger row.
17. If refresh/rebase/reconciliation changes the PR head, rerun the local gate
    and rerun required review for the changed surface.
18. Stop unless the operator has explicitly authorized pushing the refreshed PR
    head.
19. Push the refreshed head only after that authorization, then wait for CI green
    on the refreshed head.
20. Stop unless the operator has explicitly authorized merge for the exact
    verified/reviewed/CI-green PR head SHA.
21. Merge only after that authorization and a green required-check set on that
    same head SHA.
22. Return to `main`, pull the merge, and verify whether the ledger in `main`
    needs post-merge reconciliation, such as PR URL, merge SHA, final CI result,
    or phase status.
23. If post-merge reconciliation is needed, create a dedicated ledger
    bookkeeping branch. It must run the normal local gate and review gate.
24. Stop unless the operator has explicitly authorized pushing that bookkeeping
    branch.
25. Push the bookkeeping branch only after that authorization.
26. Stop unless the operator has explicitly authorized PR creation for that
    bookkeeping branch.
27. Open the bookkeeping PR only after that authorization.
28. Before final CI/merge approval for the bookkeeping PR, refresh/rebase against
    current `main` and reconcile the ledger against the current ledger in
    `main`.
29. If refresh/rebase/reconciliation changes the bookkeeping PR head, rerun the
    local gate, rerun required review for the changed surface, stop for refreshed
    head push authorization, push only after that authorization, and wait for CI
    green on the refreshed head.
30. Stop unless the operator has explicitly authorized merge for the exact
    bookkeeping PR head SHA.
31. Merge the bookkeeping PR only after that authorization. The bookkeeping PR is
    non-recursive: it records the phase/slice merge truth and does not require a
    second bookkeeping PR just to record its own bookkeeping merge.
32. Stop unless the operator has explicitly authorized starting the next phase
    or slice.
33. Continue to the next incomplete phase or slice only after that authorization.

At any point, if the current phase reveals that the next phase is unsafe or too
large, update the plan with a smaller slice, review that adjustment, and keep
the loop moving.

The document is not self-authorizing. It defines what to do after the operator
has asked for phase start, push, PR, or merge; it never grants that authority by
itself.

### Slice tracking

If a phase is split into slices, the phase remains `In progress` until every
slice is merged and verified. Each slice gets its own branch/PR/gate row in the
state ledger or a nested bullet under the phase row. A phase can be marked
`Completed` only when:

- all active slices are merged,
- superseded/canceled branches are recorded with their reason and replacement,
- the integration state is green,
- the phase acceptance target is satisfied,
- and follow-ups are either completed or explicitly moved to a later phase.

### Maximum safe parallelism

Use parallelism aggressively for investigation, review, and disjoint write
sets, but never let parallelism bypass Stoa's safety rules.

Rules:

- Use parallel read-only agents freely for codebase discovery, plan critique,
  test-gap hunting, and competitor/framework research.
- Use parallel implementation agents only when write scopes are disjoint and
  owned explicitly.
- Keep the main thread as integrator and final decision-maker.
- Do not let two implementation agents edit shared scheduler, DB migration,
  verification, merge, or UI state files at the same time unless the files are
  split intentionally.
- Prefer one code-writing agent per subsystem: DB/queries, scheduler engine,
  API/data layer, UI, tests.
- Reviewers do not edit code; they produce findings.
- If branches diverge or a shared contract changes, stop parallel writes,
  integrate, and re-plan.

Default safe pattern per phase:

- 1 main integrator.
- Up to 3 implementation agents for disjoint file sets.
- 4 review agents for the mandatory gate.
- Extra read-only explorers only when they do not block or duplicate active
  work.

## Current Stoa capability inventory

### Existing orchestration primitives

Stoa exposes an MCP orchestration server with tools for:

- Spawning workers: `spawn_worker`.
- Listing workers: `list_workers`.
- Reading worker output: `get_worker_output`.
- Sending follow-up instructions: `send_to_worker`.
- Marking workers complete: `complete_worker`.
- Killing workers: `kill_worker`.
- Running DAG pipelines: `run_pipeline` / `get_pipeline`.
- Summarizing a worker set: `get_workers_summary`.
- Shared memory, notes, channels, schedules, and operator input.

The code comment in the MCP server is directionally right: any Claude session can
act as a conductor, and workers get their own git worktrees. That is already a
strong foundation.

### Existing worker lifecycle

`lib/orchestration.ts` already does most of the hard local work:

- Validates that a conductor session exists.
- Creates a git worktree when requested.
- Creates a worker session row linked to `conductor_session_id`.
- Starts the provider through the session backend.
- Waits for a ready prompt.
- Sends the task.
- Tracks worker status and supports follow-up, completion, failure, and kill.

This is provider-neutral and aligns with Stoa's architecture rule that terminal
operations flow through `getSessionBackend()`.

### Existing pipeline engine

`lib/pipeline` already provides a pure DAG engine and a thin executor:

- Pipeline specs contain steps, dependencies, provider/model, task text, output
  files, and worktree policy.
- The engine validates malformed DAGs, duplicate ids, cycles, unsafe models,
  unsafe working directories, unsafe output paths, and invalid dependencies.
- The executor launches ready steps, polls outcomes, captures step output files,
  interpolates upstream outputs, and tears down workers.
- It bounds fan-out with `maxParallelism`, defaulting to 4.
- Pipeline run state is stored in an in-memory registry capped at 100 runs.
- API docs explicitly state pipeline runs are lost on server restart.

This means Stoa already has a useful DAG execution prototype, but it is not yet
the durable project-scale scheduler we need.

### Existing dispatch/fleet systems

Stoa already has:

- A dispatch planner with conflict-aware task/file claims.
- A default planner cap of 8 tasks.
- A sequential Command Stoa plan executor.
- Best-of-N parallel work capped at 3.
- A Fleet Board that composes dispatch rows, ceremony items, and verdict inbox
  items into lifecycle lanes.
- Fleet memory for repository-specific lessons and blocking findings.
- Cost history and fleet-level cost indicators.
- Review, verify, CI-fix, auto-merge, and merge-train modules.

These pieces should become the fleet manager's substrate.

### Gap analysis

Stoa does not yet provide a durable 40-agent fleet plan capability because:

- There is no first-class `fleet_run` object.
- There is no durable `fleet_task` graph persisted in SQLite.
- Pipeline run state is in memory and lost on restart.
- Existing pipelines default to four parallel workers and do not model cost,
  provider budgets, merge queues, review gates, or operator approvals.
- Existing dispatch planning caps at eight tasks.
- Existing Best-of-N is for selecting one winner from up to three attempts, not
  coordinating a project fleet.
- Worker status polling is per-session and can become expensive/noisy at 40
  workers if every view/action captures terminal output.
- A conductor agent's context is not a reliable source of truth for 40 active
  write-heavy tasks.
- There is no fleet-level artifact contract: workers can finish a terminal turn
  without producing a structured completion report, test evidence, risk notes,
  or merge readiness.
- There is no server-side reconciliation loop that survives page reloads,
  process restart, or a conductor thread being closed.
- There is no plan-level pause/resume/cancel/backoff policy.
- There is no merge queue that understands all active worktrees in a fleet run.

## Non-negotiable invariants

These are not polish items. Fleet Management cannot safely launch write-capable
workers until these invariants are implemented and tested:

- **Durable truth beats agent memory**: every run, task, worker attempt,
  approval, budget reservation, artifact, and merge decision is persisted before
  it affects execution.
- **Transactional scheduling**: a task is leased in SQLite before spawn, with a
  `lease_owner`, `lease_expires_at`, `scheduler_epoch`, and spawn correlation id.
- **Idempotent spawn**: repeating a scheduler tick cannot create two active
  workers for one task attempt.
- **Startup reconciliation before launch**: after server restart, Stoa reconciles
  worker process records in `leasing`, `spawning`, `running`,
  `waiting_for_operator`, and `cleanup_pending` before launching any new worker.
  Task/run records in `verifying`, `reviewing`, and `merging` are recovered by
  verifier, review, and merge-queue reconcilers, not by worker active-lease
  guards.
- **One active write worker per task**: enforced in schema/query logic; retries
  create new attempts instead of overwriting history.
- **Fail-closed worktree isolation**: implementation tasks must not fall back to
  the source checkout if worktree creation fails.
- **Existing gates remain authoritative**: dispatch verification, review,
  auto-merge, merge-train, SHA pinning, and Fleet Board/Verdict Inbox semantics
  are reused or extracted, not bypassed.
- **Human authority is explicit**: MCP tools can request or recommend approval,
  but they cannot mint human approval or merge authority for themselves.
- **Worker reports are testimony, not truth**: merge readiness comes from current
  git state, server-run verification, review artifacts, approvals, and budget
  state, not from a worker-authored markdown file alone.
- **Unknown writes serialize**: tasks with unknown or expanded file claims run
  serially or pause for approval until actual diffs are known.

## External research summary

### Claude Code subagents

Claude Code's Agent SDK documents subagents as separate agent instances that
isolate context, run analyses in parallel, use specialized instructions, and
return summaries to the parent. The most relevant lesson is context isolation:
subagents keep intermediate tool calls and exploration out of the parent
conversation. That supports Stoa's current conductor pattern for exploration,
reviews, and bounded implementation slices.

It does not imply that a single parent conversation should be the only state
store for a 40-worker project. The parent should receive structured summaries,
while Stoa owns durable state and scheduling.

Source: https://code.claude.com/docs/en/agent-sdk/subagents

### Codex subagents and MCP

The Codex manual says subagent workflows are explicitly spawned, useful for
parallel exploration, tests, triage, summarization, and multi-step feature
plans. It also warns that write-heavy parallel workflows create conflicts and
coordination overhead. Codex exposes MCP configuration, subagent settings, and
parallel threads, but its documented default `agents.max_threads` is 6, with a
default nesting depth of 1.

That is a strong signal: Codex subagents are excellent workers/reviewers, but a
40-agent plan should not depend on a single Codex context as the durable
orchestrator. Stoa should provide the fleet scheduler and use Codex/Claude as
providers inside it.

Source: https://developers.openai.com/codex/codex-manual.md

### GitHub Copilot cloud agent and third-party coding agents

GitHub's cloud-agent model is issue/branch/PR oriented. Copilot can research a
repo, create an implementation plan, make changes on a branch, run in an
ephemeral GitHub Actions-powered environment, and optionally create a PR. GitHub
also supports third-party coding agents, including Claude and Codex, from issues,
PR comments, mobile, VS Code, and an Agents tab. It emphasizes transparency:
agent work happens in branches, commits, logs, pull requests, and review flows.

The lesson for Stoa: treat each durable fleet task like a work item that can
produce an auditable branch/diff/PR, not just a terminal transcript.

Sources:

- https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent
- https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/start-copilot-sessions
- https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents

### Cursor cloud agents

Cursor's public docs describe Cloud Agents as run-based remote agents, with a
programmatic API to create and manage runs, automations for scheduled/event
work, plan mode for reviewable plans before code, and Bugbot for PR review.

The lesson for Stoa: make fleet work a run-oriented product surface. A run has
an API, a visible lifecycle, a reviewable plan, automation entry points, and
specialized review agents.

Sources:

- https://cursor.com/docs/cloud-agent
- https://cursor.com/docs/cloud-agent/api/endpoints
- https://cursor.com/docs/cloud-agent/automations
- https://cursor.com/docs/agent/plan-mode
- https://cursor.com/docs/bugbot

### LangGraph supervisor pattern

LangChain/LangGraph describes supervisor architectures where a central
supervisor coordinates specialized worker agents, often with human-in-the-loop
review and controlled information flow. The important takeaway is not the exact
library. It is the pattern: keep routing, state, interrupts, handoffs, and human
approvals explicit.

Stoa can implement the same operational pattern in its own stack: a durable
state machine plus optional AI supervisor turns.

Sources:

- https://docs.langchain.com/oss/python/langchain/multi-agent/subagents-personal-assistant
- https://reference.langchain.com/python/langgraph-supervisor

### Agent-framework evaluation: LangGraph, CrewAI, AutoGen, BeeAI, and similar

These frameworks are worth considering, but mostly as design references and
optional integration targets. They should not replace Stoa's core fleet
scheduler in v1.

The key distinction:

- Stoa's missing piece is a durable local product control plane for coding
  agents: sessions, terminals, worktrees, repo diffs, review gates, cost, and
  merge safety.
- LangGraph/CrewAI/AutoGen/BeeAI are application-agent frameworks: they help
  build agent workflows, supervisors, handoffs, crews, memory, tools,
  checkpointing, observability, and sometimes deployment.

There is overlap in orchestration concepts, but not in ownership. Stoa already
owns the terminal/session/worktree substrate, and that ownership is exactly what
must stay close to Stoa for Windows/macOS/Linux correctness.

#### LangGraph

LangGraph is the strongest design reference for durable stateful orchestration.
Its docs frame LangGraph as a low-level orchestration runtime with durable
execution, streaming, human-in-the-loop, persistence, short-term checkpoints,
long-term stores, and multi-agent patterns such as subagents, handoffs, routers,
and custom workflows.

Space in Stoa:

- Use as a reference model for graph state, interrupts, checkpointers,
  human-in-the-loop gates, and supervisor-vs-worker separation.
- Consider a later optional adapter that imports a LangGraph workflow as a fleet
  planning/review task, or runs a LangGraph app as one external worker.
- Do not make LangGraph the v1 scheduler, because that would move critical
  worktree/session/merge authority outside Stoa's TypeScript/SQLite control
  plane.

Sources:

- https://docs.langchain.com/oss/python/langgraph/overview
- https://docs.langchain.com/oss/python/langgraph/persistence
- https://docs.langchain.com/oss/python/langgraph/interrupts
- https://docs.langchain.com/oss/python/langchain/multi-agent

#### CrewAI

CrewAI has useful production concepts: crews, flows, hierarchical processes,
guardrails, memory, observability, state persistence, checkpointing, replay,
resume, and human-in-the-loop feedback. Its Flow persistence and checkpointing
docs are especially relevant because they explicitly model restart/resume and
forked execution.

Space in Stoa:

- Treat CrewAI as an external automation/workflow runtime that Stoa may launch
  as a fleet task later.
- Borrow ideas for persisted flow state, checkpoints, human feedback, and
  manager/worker decomposition.
- Do not adopt CrewAI as the core scheduler in v1: it is Python-first, higher
  level than Stoa's repo/worktree semantics, and would duplicate Stoa's existing
  dispatch/pipeline/fleet-board substrate.

Sources:

- https://docs.crewai.com/
- https://docs.crewai.com/v1.15.1/en/concepts/flows
- https://docs.crewai.com/v1.15.1/en/concepts/checkpointing
- https://docs.crewai.com/v1.15.1/en/learn/human-feedback-in-flows
- https://docs.crewai.com/v1.15.1/en/learn/hierarchical-process

#### AutoGen and Microsoft Agent Framework

AutoGen itself should not be a new Stoa dependency. The Microsoft AutoGen
repository now says AutoGen is in maintenance mode and directs new users to
Microsoft Agent Framework. The current Microsoft Agent Framework documentation
describes it as the successor that combines AutoGen's agent abstractions with
Semantic Kernel enterprise features, graph workflows, checkpointing,
human-in-the-loop support, telemetry, multi-provider model support, MCP, and
A2A.

Space in Stoa:

- Do not build new Stoa architecture on AutoGen.
- Track Microsoft Agent Framework as an optional external workflow/agent
  provider, especially because it explicitly supports MCP/A2A and coding-agent
  harness integrations.
- Use it as a comparison point for graph workflows, checkpoints, and typed
  routing, not as the owner of Stoa's merge/review/worktree safety.

Sources:

- https://github.com/microsoft/autogen
- https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/index.html
- https://learn.microsoft.com/en-us/agent-framework/overview/
- https://learn.microsoft.com/en-us/agents/architecture/multi-agent-patterns

#### BeeAI

BeeAI is interesting because it has both Python and TypeScript support, built-in
constraint enforcement, OpenTelemetry, provider-agnostic models, MCP and A2A
support, declarative orchestration, and explicit production-readiness goals. Its
docs also say dynamic multi-agent workflows are still under construction, which
makes it promising but not a safe core dependency for Stoa's first fleet
manager.

Space in Stoa:

- Consider BeeAI as a future integration target because TypeScript parity,
  MCP/A2A, constraints, and OpenTelemetry line up well with Stoa's direction.
- Borrow the idea of deterministic constraints around agent behavior.
- Do not depend on BeeAI workflows in v1 while their workflow story is still
  evolving.

Sources:

- https://framework.beeai.dev/introduction/welcome
- https://framework.beeai.dev/modules/agents

#### Similar category: durable execution runtimes

The bigger lesson from these frameworks is that "checkpointed agent state" is
not the same as "safe durable execution of external side effects." Fleet
Management has side effects that must be idempotent: spawning terminals, creating
worktrees, running git operations, asking humans, killing workers, and merging
branches. Those semantics look closer to durable workflow systems such as
Temporal/DBOS than to only a multi-agent chat framework.

Space in Stoa:

- Keep the v1 SQLite reconciler, leases, and idempotent spawn protocol.
- Design tasks as if they could later become durable activities: deterministic
  state transitions, idempotency keys, retry policy, timeouts, and compensation.
- Revisit Temporal/DBOS only if Stoa outgrows a local SQLite reconciler. Do not
  add that operational weight before the product shape is proven.

Sources:

- https://docs.temporal.io/develop/python/integrations/langgraph
- https://www.dbos.dev/blog/durable-execution-crashproof-ai-agents

### Framework adoption recommendation

Use a three-tier stance:

1. **Core**: Stoa-owned SQLite scheduler, sessions, worktrees, claims, budgets,
   reviews, verification, and merge queue.
2. **Pattern library**: borrow concepts from LangGraph, CrewAI, Microsoft Agent
   Framework, and BeeAI: checkpoints, interrupts, hierarchical managers,
   constraints, tracing, routing, and HITL.
3. **Adapters later**: allow a fleet task to invoke an external LangGraph,
   CrewAI, Microsoft Agent Framework, or BeeAI workflow as one worker or planner,
   preferably through MCP/A2A or a narrow process adapter.

Do not let an external framework become the source of truth for task ownership,
approval, budget, git state, worktree safety, or merge readiness.

## Product goal

Add Fleet Management: a Stoa-native way to take a project goal or implementation
plan, decompose it into a task graph, run many provider-neutral agents against
the graph, monitor the work, review results, and safely land the changes.

The target use case:

> "Execute this project plan with up to 40 agents. Keep changes isolated, ask me
> when blocked, respect budget/rate limits, verify every task, review the plan
> and results adversarially, then merge only green reviewed work."

## Non-goals

- Do not replace existing interactive sessions.
- Do not make every Stoa session part of a fleet run.
- Do not require Claude or Codex specifically; providers remain pluggable.
- Do not build a cloud-only design; Stoa must remain native on Windows, macOS,
  and Linux.
- Do not depend on POSIX-only commands, shell strings, `/tmp`, `/bin`, or
  `process.env.HOME`.
- Do not let a fleet run write outside the selected repo/worktree boundaries.
- Do not auto-merge unreviewed agent work.

## Core design decision

Use a server-owned durable fleet state machine, with optional AI conductors.

The conductor pattern remains useful for:

- Planning and decomposition.
- Adversarial review.
- Summarizing progress.
- Answering operator questions.
- Issuing high-level rerouting instructions.

The server owns:

- Durable run/task/worker/event state.
- Scheduling.
- Concurrency limits.
- Cost/rate budgets.
- Worktree ownership.
- Worker heartbeats.
- Artifact collection.
- Review/verify gating.
- Merge queue.
- Cleanup.

This avoids the failure mode where 40 agents are "managed" only by one chat
context, which becomes noisy, expensive, fragile, and easy to desynchronize.

## Domain model

### Fleet run

A fleet run is one project-scale execution. It may start from:

- A free-text goal.
- A markdown plan.
- A GitHub issue or milestone.
- A dispatch planner output.
- A pipeline spec.
- A saved workflow template.

Suggested statuses:

- `draft`: created but not planned.
- `planning`: planner/reviewer agents are producing a task graph.
- `awaiting_approval`: plan is ready for operator edits/approval.
- `running`: scheduler may launch ready tasks.
- `paused`: no new tasks launch; existing tasks may continue or be stopped
  depending on pause mode.
- `reviewing`: all runnable work is done and review gates are active.
- `merging`: merge queue is landing ready work.
- `completed`: all required work landed or explicitly accepted.
- `failed`: unrecoverable run-level failure.
- `canceled`: operator canceled the run.

### Fleet task

A fleet task is the durable unit of work. It should be small enough that one
agent can complete it with clear acceptance criteria.

Suggested statuses:

- `planned`
- `ready`
- `blocked`
- `leasing`
- `spawning`
- `running`
- `waiting_for_operator`
- `needs_followup`
- `needs_inspection`
- `verifying`
- `reviewing`
- `fixing`
- `ready_to_merge`
- `merging`
- `merged`
- `failed`
- `canceled`
- `skipped`

Task fields:

- `id`
- `fleet_run_id`
- `title`
- `description`
- `task_type`: `explore`, `implement`, `test`, `review`, `verify`, `docs`,
  `merge`, `cleanup`.
- `priority`
- `status`
- `agent_type`
- `model`
- `reasoning_effort`
- `working_directory`
- `base_branch`
- `branch_name`
- `worktree_path`
- `max_attempts`
- `attempt`
- `verify_command`
- `acceptance_criteria`
- `operator_notes`
- `created_at`
- `updated_at`
- `started_at`
- `ended_at`

### Dependencies

Use a separate table for edges:

- `fleet_task_dependencies(id, fleet_run_id, task_id, depends_on_task_id,
dependency_type)`

Dependency types:

- `blocks`: downstream cannot run until upstream succeeds.
- `informs`: downstream may run but should include upstream output if available.
- `review_of`: reviewer task evaluates another task.
- `fixes`: follow-up task addresses findings from another task.

### File claims

Use dispatch claim normalization unchanged for v1. Dispatch claims are
repo-relative exclusive prefixes with strict normalization and overlap checks;
Fleet Management should not introduce richer read/write semantics until it can
prove those semantics do not loosen conflict serialization.

- `fleet_task_claims(id, fleet_run_id, task_id, path, claim_type, confidence)`

V1 claim types:

- `unknown`
- `exclusive`

Scheduling rules:

- Tasks with conflicting `exclusive` claims cannot run concurrently.
- Tasks with `unknown` write claims cannot run concurrently with any other
  write-capable task in the same run. They run one at a time, or pause until
  their claims are refined and approved.
- Review/test/docs tasks can usually overlap with implementation tasks if their
  claims are read-only.
- After every worker diff, Stoa recomputes actual touched paths from git and
  feeds them back into scheduling. Actual writes outrank planned claims.
- A task that touches unclaimed files is quarantined until explicit operator
  approval. Sensitive paths such as credentials, CI, package manager lockfiles,
  migrations, auth code, and shared config require stronger review.

### Worker records

Fleet worker records connect tasks to Stoa sessions:

- `fleet_workers(id, fleet_run_id, task_id, session_id, provider, model,
worktree_path, status, spawned_at, last_heartbeat_at, ended_at)`

One task can have multiple workers over retries/fix attempts, but only one active
primary implementation worker unless explicitly configured.

Worker status vocabulary:

- `leasing`
- `spawning`
- `running`
- `waiting_for_operator`
- `completed`
- `failed`
- `canceled`
- `dead`
- `cleanup_pending`
- `cleanup_complete`

Merge work should be represented on the task or merge-queue record, not by
pretending an implementation worker is still running. Restart recovery must
reconcile task statuses such as `merging` separately from worker process status.

### Artifacts

Artifacts are structured outputs produced by workers and by Stoa itself:

- `fleet_artifacts(id, fleet_run_id, task_id, worker_id, artifact_type, path,
content, metadata_json, created_at)`

Artifact types:

- `completion_report`
- `plan`
- `diff_summary`
- `test_log`
- `review_findings`
- `operator_question`
- `merge_report`
- `cost_report`
- `status_summary`

### Events

Fleet events are append-only and power the UI timeline:

- `fleet_events(id, fleet_run_id, task_id, worker_id, event_type, severity,
message, metadata_json, created_at)`

Examples:

- `task_ready`
- `worker_spawned`
- `worker_heartbeat`
- `worker_output_captured`
- `artifact_submitted`
- `verify_started`
- `verify_failed`
- `review_blocked`
- `operator_input_requested`
- `merge_conflict`
- `budget_exhausted`

## Database plan

Add migrations in `lib/db/migrations.ts` and schema text in `lib/db/schema.ts`.
Prefer references to existing authoritative rows over free-floating text:

- Link fleet runs to the existing repo/project model where available.
- Link planner/conductor/worker sessions to `sessions(id)`.
- Link dispatch-backed work to `issue_dispatches(id)` or ceremony rows where
  appropriate.
- Link pipeline-backed work to a pipeline run id when a fleet run imports or
  wraps a pipeline.
- Treat raw paths as display/cache fields, not as the scheduler's trust root.

### V1 integration posture

Fleet Management v1 should add these adapter boundaries:

- `fleet_run` groups existing sessions, dispatch rows, pipeline runs, artifacts,
  and review/merge ceremonies.
- `fleet_task.dispatch_id` links a fleet task to an existing dispatch row when
  the work is issue/PR-shaped.
- `fleet_task.pipeline_step_id` links imported DAG work to pipeline semantics.
- `fleet_workers.session_id` links to the existing `sessions` table.
- Verification uses dispatch verification.
- Merge uses dispatch auto-merge/merge-train.
- Fleet Board and Verdict Inbox remain the cross-fleet attention surfaces.

Only add new fleet tables for run-level grouping, task graph state, approvals,
leases, resource/budget reservations, fleet-specific artifacts, and events.

Suggested tables:

```sql
CREATE TABLE fleet_runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  repo_id TEXT,
  project_id TEXT,
  working_directory TEXT NOT NULL,
  base_branch TEXT,
  status TEXT NOT NULL,
  max_parallel_workers INTEGER NOT NULL DEFAULT 4,
  max_total_workers INTEGER NOT NULL DEFAULT 40,
  max_provider_parallel_json TEXT,
  budget_usd REAL,
  budget_tokens INTEGER,
  reserved_budget_usd REAL NOT NULL DEFAULT 0,
  reserved_budget_tokens INTEGER NOT NULL DEFAULT 0,
  cost_confidence TEXT NOT NULL DEFAULT 'unknown',
  planner_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  conductor_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  plan_markdown TEXT,
  approved_plan_hash TEXT,
  approval_state TEXT NOT NULL DEFAULT 'unapproved',
  scheduler_epoch INTEGER NOT NULL DEFAULT 0,
  recovery_required INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);

CREATE TABLE fleet_tasks (
  id TEXT PRIMARY KEY,
  fleet_run_id TEXT NOT NULL REFERENCES fleet_runs(id) ON DELETE CASCADE,
  dispatch_id TEXT,
  pipeline_step_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  task_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  model TEXT,
  reasoning_effort TEXT,
  working_directory TEXT,
  base_branch TEXT,
  branch_name TEXT,
  worktree_path TEXT,
  verify_spec_json TEXT,
  acceptance_criteria TEXT,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  current_attempt INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  scheduler_epoch INTEGER NOT NULL DEFAULT 0,
  spawn_request_id TEXT,
  approved_task_hash TEXT,
  approval_state TEXT NOT NULL DEFAULT 'unapproved',
  last_actual_claim_hash TEXT,
  failure_code TEXT,
  operator_notes TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);

CREATE TABLE fleet_task_dependencies (
  id TEXT PRIMARY KEY,
  fleet_run_id TEXT NOT NULL REFERENCES fleet_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES fleet_tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES fleet_tasks(id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL
);

CREATE TABLE fleet_task_claims (
  id TEXT PRIMARY KEY,
  fleet_run_id TEXT NOT NULL REFERENCES fleet_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES fleet_tasks(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  claim_type TEXT NOT NULL DEFAULT 'exclusive',
  confidence REAL NOT NULL DEFAULT 1.0
);

CREATE TABLE fleet_workers (
  id TEXT PRIMARY KEY,
  fleet_run_id TEXT NOT NULL REFERENCES fleet_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES fleet_tasks(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  spawn_request_id TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT,
  worktree_path TEXT,
  status TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_observed_session_status TEXT,
  heartbeat_deadline INTEGER,
  cleanup_status TEXT NOT NULL DEFAULT 'not_started',
  terminal_cause TEXT,
  failure_code TEXT,
  spawned_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER,
  ended_at INTEGER,
  metadata_json TEXT
);

CREATE TABLE fleet_artifacts (
  id TEXT PRIMARY KEY,
  fleet_run_id TEXT NOT NULL REFERENCES fleet_runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES fleet_tasks(id) ON DELETE CASCADE,
  worker_id TEXT REFERENCES fleet_workers(id) ON DELETE SET NULL,
  artifact_type TEXT NOT NULL,
  path TEXT,
  content TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE fleet_events (
  id TEXT PRIMARY KEY,
  fleet_run_id TEXT NOT NULL REFERENCES fleet_runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES fleet_tasks(id) ON DELETE CASCADE,
  worker_id TEXT REFERENCES fleet_workers(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
```

Add indexes:

- `fleet_tasks(fleet_run_id, status, priority)`
- `fleet_task_dependencies(fleet_run_id, task_id)`
- `fleet_task_dependencies(fleet_run_id, depends_on_task_id)`
- `fleet_task_claims(fleet_run_id, path)`
- `fleet_workers(fleet_run_id, status)`
- `fleet_workers(session_id)`
- `fleet_workers(fleet_run_id, task_id, attempt_number)`
- `fleet_workers(spawn_request_id)`
- `fleet_artifacts(fleet_run_id, task_id, artifact_type)`
- `fleet_events(fleet_run_id, created_at)`

Keep query wrappers typed, following the ongoing database-query typing roadmap.

Add constraints or transactional query guards for:

- One active `fleet_workers` row per `(fleet_run_id, task_id)` where status is
  `leasing`, `spawning`, `running`, `waiting_for_operator`, or
  `cleanup_pending`.
- Unique `spawn_request_id`.
- No launch from an unapproved task/run.
- No launch while `recovery_required = 1`.

If SQLite partial indexes are awkward in the current migration style, enforce
the same invariant inside a single transaction that checks and inserts/updates
under one write lock.

## Scheduler architecture

Create a pure scheduler core:

- `lib/fleet/types.ts`
- `lib/fleet/engine.ts`
- `lib/fleet/conflicts.ts`
- `lib/fleet/budgets.ts`
- `lib/fleet/prompts.ts`

Create side-effecting shells:

- `lib/fleet/reconciler.ts`
- `lib/fleet/spawn.ts`
- `lib/fleet/artifacts.ts`
- `lib/fleet/verify.ts`
- `lib/fleet/review.ts`
- `lib/fleet/merge.ts`

The pure engine should answer:

- Which tasks are ready?
- Which ready tasks can run together without claim conflicts?
- Which tasks are blocked by failed dependencies?
- Which tasks exceed retry limits?
- Whether a run is complete, failed, paused, or waiting for operator input.
- Whether budgets permit another launch.
- Whether a task should be verified, reviewed, fixed, merged, or marked failed.

The reconciler should:

- Load active fleet runs from SQLite.
- Acquire a per-run lock so two ticks cannot spawn duplicate workers.
- Recompute ready work.
- Launch workers up to the effective concurrency cap.
- Poll active workers cheaply.
- Capture structured artifacts.
- Transition tasks through verify/review/merge states.
- Record events.
- Back off on repeated provider or spawn failures.

### Transactional launch protocol

Worker launch must be idempotent:

1. Reconciler starts a SQLite transaction.
2. It checks run approval, task approval, budget reservation, recovery state,
   dependency state, file-claim conflicts, and resource availability.
3. It transitions one task from `ready` to `leasing` with a fresh
   `lease_owner`, `lease_expires_at`, incremented `scheduler_epoch`, and
   deterministic `spawn_request_id`.
4. It inserts a `fleet_workers` attempt row with the same `spawn_request_id`.
5. It commits before starting any external process.
6. It calls the fleet spawn wrapper.
7. It records session id/worktree path and transitions to `running`, or records
   a terminal spawn failure that releases reservations and resources.

On duplicate ticks, the second reconciler sees the active lease/worker and does
not spawn. On crash, startup recovery reconciles the leased/spawning row before
new launch.

### Startup recovery

Minimal restart recovery ships with worker launch, not later. At process start,
and before any explicit `/tick` can launch workers, Stoa must:

- Mark active fleet runs `recovery_required = 1`.
- Reconcile workers in `leasing` or `spawning` by `spawn_request_id`.
- Check whether linked `sessions(id)` still exist.
- Check last observed status through the session backend/status detector.
- Expire stale leases.
- Preserve orphaned worktrees for inspection.
- Refuse to spawn replacements until each active run is either recovered,
  paused for operator input, or canceled.

### Resource admission controller

Provider concurrency is not enough. The scheduler also needs resource slots for:

- pty sessions.
- pty-host/transport capacity.
- verifier subprocesses.
- git operations.
- merge/rebase operations.
- per-repo worktree count.
- disk bytes under fleet-owned worktrees/artifacts.
- output/artifact bytes per minute.
- UI/event fanout.

A task launches only after all required resources are reserved. Resources are
released on completion, verified cleanup, or operator-approved preservation.

## Concurrency model for 40 agents

Separate total plan size from active concurrency.

Recommended defaults:

- `max_total_workers`: 40.
- `max_parallel_workers`: 6 locally.
- `max_parallel_workers` warning threshold: 12.
- Provider caps:
  - Claude: 4 active by default.
  - Codex: 6 active by default.
  - Other providers: 2 active until proven stable.
- Review/explore tasks can use lower-cost/faster models.
- Implementation tasks use stronger defaults.

Why not run 40 simultaneously by default?

- Local CPU, pty, terminal capture, git, file watchers, and provider limits can
  become the bottleneck.
- Write-heavy conflicts grow faster than linearly.
- Token and cost burn can spike.
- Operator attention becomes the limiting resource.

The UI can still say "40-agent fleet" if the run has 40 planned workers, but the
scheduler should launch them in controlled waves.

## Worker prompt contract

Fleet worker launch must use a fleet-specific spawn wrapper around
`spawnWorker`:

- Implementation tasks require `useWorktree=true`.
- If worktree creation returns no `worktree_path`, launch fails.
- The wrapper records `spawn_request_id`, attempt number, and ownership before
  starting the provider.
- The wrapper must never silently run a write task in the source checkout.
- Tests must assert this behavior, because current generic worker spawning can
  fall back to the original directory when worktree creation fails.

Every fleet worker prompt should include:

- Fleet run name and goal.
- Task id and title.
- Task description.
- Acceptance criteria.
- Allowed file claims.
- Explicit forbidden paths, if any.
- Dependency summaries and artifact links.
- Required verification command.
- Required output format.
- Reminder that other agents may be editing nearby code.
- Instruction not to revert unrelated changes.
- Instruction to ask an operator question instead of guessing on blockers.
- Instruction to write a completion report artifact.

Required completion report:

```markdown
# Fleet Task Completion Report

Task: <task id>
Status: succeeded | blocked | failed

## Summary

...

## Files changed

- ...

## Verification

- Command:
- Result:
- Evidence:

## Risks

- ...

## Follow-ups

- ...

## Merge readiness

ready | not-ready
```

Initially, this can be written into a fleet-owned artifact store outside the
repo checkout, such as `$STOA_HOME/fleet/<run-id>/<task-id>/<attempt>/report.md`,
or persisted directly in SQLite as a `fleet_artifacts` row. Read it after an
explicit done signal. Avoid repo-relative magic files that can collide with user
work or accidentally enter the merge diff. Reuse pipeline output semantics where
useful, but keep fleet artifacts outside merge candidates unless the operator
explicitly exports them.

The report must include a nonce/task id/attempt id, schema version, base commit,
head commit, and timestamp after spawn. Stoa validates these against the current
worktree. Idle plus a missing, stale, or invalid report becomes
`needs_inspection`, not success.

Later, add an MCP tool:

- `fleet_submit_report`
- `fleet_update_status`
- `fleet_request_operator_input`
- `fleet_submit_artifact`

Reports are never sufficient for merge readiness by themselves. The server must
also compute the diff, run verification through the dispatch verification
runner, check approval state, and attach independent review artifacts.

## Planning flow

### Step 1: Create run

Operator opens Fleet Management and enters:

- Goal or plan.
- Repo/working directory.
- Base branch.
- Provider/model defaults.
- Max parallel workers.
- Budget/cost guard.
- Whether to prepare PR drafts and request PR-creation authorization after an
  authorized push.
- Required verification commands.
- Review gate.

### Step 2: Decompose

Stoa launches one planner session or uses the current session as planner.
Planner output is a structured plan, not free-form only:

- Tasks.
- Dependencies.
- File claims.
- Acceptance criteria.
- Suggested providers/models.
- Verification commands.
- Risk notes.

The existing dispatch planner should be refactored so its parser/output model
can generate `fleet_tasks` as well as dispatch rows. The current default task cap
of 8 should remain for dispatch, but Fleet Management should accept a configured
cap with a hard safety ceiling.

### Step 3: Adversarial plan review

Before approval, run plan critics:

- Correctness/security critic.
- Cross-platform/conventions critic.
- Scope/conflict critic.
- Optional cost/time critic.

Each critic produces findings against the plan, not code. Findings can mutate
the plan only through an explicit planner revision step, so the operator can
see what changed.

### Step 4: Operator approval

Show:

- Task graph.
- Expected files touched.
- Dependency lanes.
- Estimated worker count.
- Estimated max concurrency.
- Budget estimate.
- Review/merge policy.
- Known risks.

Operator can:

- Approve.
- Edit tasks.
- Change caps.
- Disable tasks.
- Require a task to wait for manual approval.
- Convert risky tasks to read-only exploration.

### Step 5: Execute waves

The scheduler launches ready tasks in waves, respecting:

- Dependency graph.
- File claim conflicts.
- Provider caps.
- Cost budget.
- Worktree limits.
- Operator pause/cancel.
- Existing active worker count.

### Step 6: Collect artifacts

When a worker submits an explicit done signal, or becomes idle after being
observed running and has a valid report:

- Capture terminal status.
- Read the fleet-owned report artifact.
- Compute diff summary.
- Recompute actual file claims from git diff.
- Store artifacts.
- Transition to verifying or failed/blocked.

If the report is missing, stale, malformed, mismatched to the current diff, or
claims files outside approval, quarantine the task as `needs_inspection`.

### Step 7: Verify and review

Per task:

- Run configured verification through the existing dispatch verification runner
  or an extracted shared verifier. Store normalized argv/spec, not arbitrary
  shell text.
- Run four independent review dimensions for every implementation/docs/config
  change before merge readiness: correctness/security,
  conventions/cross-platform, simplicity/UX, and adversarial red-team.
- Ensure reviewer independence: the implementing worker or same session context
  cannot be the only reviewer for its own work.
- Record findings.
- If blocking findings exist, create fix tasks or return the task to a worker.
- If clean, mark `ready_to_merge`.

### Step 8: Merge

Use existing dispatch auto-merge and merge-train primitives as the merge engine.
Fleet Management may group and order tasks, but it should inherit dispatch's
SHA pinning, PR readiness checks, stale-head refusal, re-review after rebase,
verification verdicts, and worktree cleanup. Do not build a separate merge
engine first.

- Rebase/update each worktree branch against current integration base.
- Detect conflicts.
- Run verification after applying each task.
- Merge in dependency order.
- Prefer small PRs/branches for auditability.
- Batch only tasks with disjoint claims and green verification.

## API plan

### Authority model

Fleet API and MCP tools must use explicit capabilities:

- `fleet:read`: inspect runs, tasks, artifacts, and events.
- `fleet:worker-write`: submit worker artifacts/status for the current assigned
  task only.
- `fleet:operator-control`: pause/resume/message/interrupt non-destructive work.
- `fleet:approval`: approve plans, material task changes, retry-after-failure,
  claim expansion, and budget changes.
- `fleet:merge-admin`: start merge batches, approve conflict resolution, and
  perform destructive cleanup.

Rules:

- Human-originated approval tokens are required for `approve`, `resume`,
  `cancel`, `worker kill`, `merge`, destructive cleanup, cancel-and-clean, and
  any action that widens scope or restarts spend.
- MCP tools may request approvals and present recommendations, but cannot grant
  themselves approval authority.
- Every privileged action writes an immutable event with actor, source
  (`human`, `mcp`, `api`, `scheduler`), capability, target id, prior state, new
  state, and approval token id when applicable.
- Worker-scoped tools cannot read or mutate other tasks except through approved
  shared artifacts.

### Approval drift controls

A single initial approval is not enough for a 40-agent run. Store hashes for the
approved run plan and each approved task. Block execution when the current plan
differs materially from the approved version.

Approval checkpoints:

- Initial plan approval.
- Planner revision that changes task scope, dependencies, file claims,
  verification, provider/model, budget, or merge policy.
- Any task that expands actual file claims beyond approved claims.
- Retry after failed verification or blocking review.
- Any destructive action.
- Every merge batch.
- Budget increase or hard-budget override.

The UI must show "approved vs current" diffs and explain why the approval is
required.

Add routes:

- `GET /api/fleet/runs`
- `POST /api/fleet/runs`
- `GET /api/fleet/runs/[id]`
- `PATCH /api/fleet/runs/[id]`
- `POST /api/fleet/runs/[id]/plan`
- `POST /api/fleet/runs/[id]/approve`
- `POST /api/fleet/runs/[id]/pause`
- `POST /api/fleet/runs/[id]/resume`
- `POST /api/fleet/runs/[id]/cancel`
- `POST /api/fleet/runs/[id]/tick` (scheduler-internal only; rejects MCP and
  operator clients unless they present the scheduler service identity)
- `GET /api/fleet/runs/[id]/events`
- `GET /api/fleet/runs/[id]/tasks`
- `PATCH /api/fleet/tasks/[id]`
- `POST /api/fleet/tasks/[id]/retry`
- `POST /api/fleet/tasks/[id]/verify`
- `POST /api/fleet/tasks/[id]/review`
- `POST /api/fleet/tasks/[id]/merge`
- `GET /api/fleet/tasks/[id]/artifacts`
- `POST /api/fleet/workers/[id]/message`
- `POST /api/fleet/workers/[id]/kill`

MCP tools can wrap these routes:

- `fleet_create_run`
- `fleet_plan_run`
- `fleet_approve_run`
- `fleet_get_run`
- `fleet_list_tasks`
- `fleet_pause_run`
- `fleet_resume_run` (requires a human-originated approval token and fresh
  approval/budget validation before launching work)
- `fleet_cancel_run` (requires a human-originated approval token; destructive
  cleanup additionally requires a destructive-action token)
- `fleet_submit_artifact`
- `fleet_request_operator_input`

State-changing MCP wrappers are request-capable by default. They can attach a
human approval token gathered through the UI, but they cannot self-authorize a
resume, cancel, worker kill, cleanup, or merge. `/tick` is not an MCP tool; it is
the scheduler's idempotent reconciler entrypoint.

## UI plan

Add a new Fleet Management view distinct from the current Fleet Board.

Current Fleet Board answers:

> "What autonomous work exists across lifecycle lanes?"

New Fleet Management answers:

> "How is this project-scale plan executing, what needs attention, and what is
> safe to merge?"

The primary screen should be an attention queue, not six equally loud
dashboards. For 40 agents, the operator needs the next required decision first.

Attention priority:

1. Budget stopped or cost telemetry unavailable.
2. Approval required.
3. Security or secret finding.
4. Merge conflict.
5. Failed verification.
6. Blocking review finding.
7. Worker blocked question.
8. Stale/dead worker.
9. Claim drift/quarantined task.

Graphs, task boards, worker tables, timelines, and artifacts are drill-downs
from that queue.

### View structure

Top bar:

- Run selector.
- Status.
- Pause/resume/cancel.
- Max concurrency control.
- Budget/cost badge.
- Needs-attention badge.

Main sections:

- Plan graph / DAG.
- Task board.
- Worker table.
- Event timeline.
- Artifact drawer.
- Merge queue.

Task card:

- Title/status.
- Agent/provider/model.
- Dependency state.
- File claims.
- Worktree/branch.
- Verification state.
- Review state.
- Cost estimate/actual.
- Last event.
- Open session.
- Open diff.
- Message worker.
- Retry/kill/skip.

Worker table:

- Session id.
- Provider/model.
- Status from status detector.
- Task.
- Worktree.
- Last heartbeat.
- Last output summary.
- Tokens/cost when available.

Operator attention queue:

- Blocked questions.
- Review findings requiring decision.
- Merge conflicts.
- Budget/rate-limit stops.
- Failed verification.
- Security/secret findings.
- Claim drift.
- Stale/dead workers.

Bulk actions are allowed only when they are safe and previewable. Destructive
bulk actions require explicit approval and must show affected workers,
worktrees, branches, artifacts, and expected data loss.

### Mobile behavior

Because Stoa is mobile-first, provide:

- One-column run summary.
- Segmented tabs: Plan, Tasks, Workers, Events, Merge.
- Sticky attention bar.
- Compact task cards.
- Progressive disclosure for terminal output and artifacts.

## Cost and rate-limit management

Fleet Management must include cost controls from v1.

Run settings:

- Budget in USD.
- Budget in tokens.
- Max active workers.
- Max workers per provider.
- Max retries per task.
- Stop mode: pause before budget, hard stop at budget, or ask operator.

Scheduler behavior:

- Before spawning, reserve budget from a conservative estimate based on task
  type/model/provider and prior run history.
- Decrement available budget by reservations before launch; release unused
  reservation on completion.
- If cost telemetry is missing or low-confidence and the run is in hard-budget
  mode, do not launch more workers.
- During execution, aggregate session cost from existing cost tracking.
- If a run exceeds warning threshold, emit event and show UI warning.
- If it reaches hard budget, pause and stop launching new tasks.
- In hard-stop mode, request graceful interruption of active workers at the next
  safe point, then stop them if they continue spending beyond configured grace.
- Track provider rate-limit cooldowns as scheduler state.
- Prefer mini/low-cost models for read-only scans where configured.

This directly addresses the risk that a 40-agent fleet can turn one operator
action into an expensive burst.

## Pause and cancel semantics

Operators must choose explicit modes:

- `pause-new`: stop launching new workers; active workers continue.
- `pause-and-interrupt`: stop launching and ask active workers to reach a safe
  stopping point with a report.
- `cancel-preserve-worktrees`: stop/kill active workers, preserve branches,
  worktrees, artifacts, and events for inspection.
- `cancel-and-clean-owned-worktrees`: destructive cleanup of fleet-owned
  worktrees after explicit approval.

Persist kill/cancel requests and terminal evidence. Restart recovery must not
resurrect canceled work or delete preserved worktrees.

## Status aggregation strategy

Avoid polling 40 full terminal captures for every UI refresh.

Use a reconciler tick:

- Poll active workers on a bounded interval.
- Enforce max terminal captures per tick.
- Enforce per-worker minimum capture interval.
- Separate cheap heartbeat/status checks from expensive terminal capture.
- Apply adaptive backoff for stable idle/running workers.
- Coalesce repetitive events.
- Enforce max artifact/event bytes per minute.
- Store last known status and heartbeat in `fleet_workers`.
- Capture full output only on task transition, explicit user request, or sparse
  sampling.
- Store short status summaries as artifacts/events.

UI reads durable summaries first. It can lazily fetch terminal output for one
selected worker.

A 40 fake-worker performance test must land before real worker launch, not as
late hardening. It should assert bounded DB writes, bounded terminal captures,
bounded event bytes, and responsive run-detail queries.

## Merge strategy

Default strategy:

- One branch/worktree per implementation task.
- Keep exploration/review tasks read-only where possible.
- Use dependency order plus file-claim conflict ordering.
- Require verification and review before merge.
- Merge through a queue that re-validates after each integration.

Optional strategies:

- Batch merge disjoint tasks.
- Create one PR per task.
- Create one PR per milestone group.
- Keep local-only integration branch for experimental runs.

Never merge:

- Tasks with missing completion report.
- Tasks with failed verification.
- Tasks with unresolved blocking review findings.
- Tasks that touched files outside claims without review.
- Tasks that ask unresolved operator questions.
- Tasks whose current head SHA no longer matches the verified/reviewed SHA.
- Tasks whose actual touched files differ materially from approved claims unless
  the operator approved the drift.

## Security and safety

Fleet runs multiply risk. Add guardrails:

- Use existing path sandboxing and project boundary checks.
- Validate working directories through existing platform helpers.
- Validate model strings as pipeline does.
- Store fleet artifacts in `$STOA_HOME` or DB-backed rows by default; validate
  any optional exported artifact path as explicitly operator-approved and outside
  merge candidates unless the export itself is the requested change.
- Deny shell-string execution in fleet code.
- Use `execFile`/argv helpers for git and verification commands where practical.
- Never expose secrets in prompts, artifacts, or event logs.
- Redact terminal output before storing long artifacts if it matches secret
  patterns.
- Make destructive cleanup explicit and scoped to fleet-owned worktrees.
- Track every agent-spawned branch/worktree as owned by one task/run.

## Cross-platform requirements

All implementation must follow Stoa's repo rules:

- Use `lib/platform.ts` server-side helpers.
- Do not use POSIX-only utilities.
- Do not assume `/tmp`, `/bin`, `HOME`, slash-separated paths, or shell pipes.
- Client code must not import server-only modules.
- Keep terminal operations behind `SessionBackend` and `PtyTransport`.
- Ensure daemon tests isolate sockets with `STOA_PTY_HOST_NAME`.

## Tests

Pure unit tests:

- Fleet DAG validation.
- Status transitions.
- Dependency blocking and skip propagation.
- File-claim conflict detection.
- Concurrency cap selection.
- Provider cap selection.
- Budget pause behavior.
- Retry exhaustion.
- Merge queue ordering.

DB tests:

- Migrations.
- Insert/list/update fleet runs.
- Insert/list/update tasks.
- Dependency and claim queries.
- Artifact/event persistence.
- Resume active run after process restart.

Integration tests with fakes:

- Reconciler launches ready tasks.
- Reconciler does not launch conflicting tasks.
- Reconciler recovers from spawn failure.
- Worker idle after running reads report artifact.
- Missing report blocks merge.
- Pause prevents new launches but preserves active workers.
- Cancel kills active fleet-owned workers.

UI tests:

- Fleet Management run list.
- Run detail renders task lanes.
- Attention queue counts blocked tasks.
- Pause/resume/cancel actions.
- Worker output lazy loading.
- Mobile segmented view.

Regression tests:

- Pipeline behavior remains unchanged.
- Existing Fleet Board lane composition remains unchanged.
- Existing dispatch planner cap remains unchanged outside Fleet Management.

## Implementation phases

### Phase state ledger

This ledger is the campaign resume surface. Update pre-merge fields on the
phase/slice branch before commit. Update post-merge fields only after the merge
truth exists; if that requires a bookkeeping PR, that PR is gated but does not
itself need another bookkeeping PR.

| Phase                                             | Status      | Active branch/slice | Pre-merge evidence                                                                                                                                                                                                                                                                                        | Post-merge reconciliation                                                                                                             | Current next action                                                                                        | Notes                                                                                                                                                    |
| ------------------------------------------------- | ----------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0: Plan and loop                            | Completed   | Merged via PR #391  | Local gate green on branch head: `npx prettier --check .`, `npx tsc --noEmit`, `npm test` (306 files, 3539 tests), and `npm run build` pass with existing Turbopack warning; four-agent review clean after adversarial fixes; PR #391 final head `68efb34` had all CI checks green                        | Merged 2026-07-08 as `97aed5f`; final CI run `28982835413` green on `68efb34`; bookkeeping recorded by gated PR path                  | Phase 1 completed via PR #393                                                                              | Creates the durable plan, framework evaluation, visible execution contract, state ledger, and phase loop.                                                |
| Phase 1: Durable model and read-only UI           | Completed   | Merged via PR #393  | Local gate green on branch head: `npx tsc --noEmit`, `npx prettier --check .`, `npm test` (310 files, 3558 tests), and `npm run build` pass with existing Turbopack warning; Chrome smoke test passed; final four-agent review clean; PR #393 final head `1643f51` had PR-head CI run `28985939366` green | Merged 2026-07-09 as `3c5cecd`; merged-state main push CI run `28986123466` green on `3c5cecd`; bookkeeping recorded by gated PR path | Phase 2 completed via PR #395                                                                              | Delivered durable draft-run model, read-only Fleet Management UI, approval preview, bounded draft payloads, no worker spawning, and client import tests. |
| Phase 2: Plan ingestion and decomposition         | Completed   | Merged via PR #395  | Local gate green on branch head: `npx tsc --noEmit`, `npx prettier --check .`, `npm test` (313 files, 3582 tests), and `npm run build` pass with existing Turbopack warning; browser smoke passed; final four-agent review clean; PR #395 final head `0efe58b` had PR-head CI run `29002393867` green     | Merged 2026-07-09 as `983d123`; merged-state main push CI run `29002655048` green on `983d123`; bookkeeping recorded by gated PR path | Start Phase 3 branch after this bookkeeping PR is merged and operator phase-start authorization is granted | Delivered durable plan ingestion, stable plan hashes, approval, critic artifacts, blocker gates, route body caps, and partial-schema repair.             |
| Phase 3: Scheduler and worker launch              | Next        | TBD                 | Required: full local gate + four-agent review + CI                                                                                                                                                                                                                                                        | Pending future phase merge                                                                                                            | Create Phase 3 branch after Phase 2 bookkeeping merges and operator phase-start authorization is granted   | Requires leases, idempotent spawn, startup recovery, resource admission, and 40 fake-worker perf test before real launch.                                |
| Phase 4: Artifact contract and status aggregation | Not started | TBD                 | Required: full local gate + four-agent review + CI                                                                                                                                                                                                                                                        | Pending future phase merge                                                                                                            | Pending Phase 3                                                                                            | Fleet-owned reports, actual claims, bounded polling.                                                                                                     |
| Phase 5: Verify and review gates                  | Not started | TBD                 | Required: full local gate + four-agent review + CI                                                                                                                                                                                                                                                        | Pending future phase merge                                                                                                            | Pending Phase 4                                                                                            | Dispatch verifier reuse and mandatory independent reviews.                                                                                               |
| Phase 6: Merge integration                        | Not started | TBD                 | Required: full local gate + four-agent review + CI                                                                                                                                                                                                                                                        | Pending future phase merge                                                                                                            | Pending Phase 5                                                                                            | Reuse dispatch auto-merge/merge-train and SHA pinning.                                                                                                   |
| Phase 7: Lifecycle hardening                      | Not started | TBD                 | Required: full local gate + four-agent review + CI                                                                                                                                                                                                                                                        | Pending future phase merge                                                                                                            | Pending Phase 6                                                                                            | Cleanup, archival, retention, analytics, optional cloud hooks.                                                                                           |
| Phase 8: AI supervisor layer                      | Not started | TBD                 | Required: full local gate + four-agent review + CI                                                                                                                                                                                                                                                        | Pending future phase merge                                                                                                            | Pending Phase 7                                                                                            | Optional supervisor over durable summaries, not source of truth.                                                                                         |

### UI, create, and orchestration emphasis

Fleet Management is not a backend-only scheduler. The product is the operator's
ability to maintain the fleet.

Every phase should preserve or improve:

- Create flow: goal/plan input, repo selection, budget, model/provider defaults,
  review policy, max concurrency, and approval preview.
- Management flow: attention queue first, then graph, tasks, workers, events,
  artifacts, and merge readiness.
- Orchestration flow: safe worker launch, message/interrupt/kill, pause/cancel
  modes, operator questions, and MCP tools that respect authority boundaries.
- Mobile flow: one-column status, sticky attention, compact task cards, and
  lazy terminal/artifact drill-down.
- Testability: pure engines first, fake workers before real workers, UI tests
  around the operator decisions that matter.

### Phase 1: Durable model and read-only UI

Deliver:

- SQLite tables and typed queries.
- Pure `lib/fleet/engine.ts`.
- Adapter links to existing sessions, dispatch rows, pipeline runs, Fleet Board,
  Verdict Inbox, verification, and merge primitives.
- Authority model and approval/audit event model.
- `GET/POST /api/fleet/runs`.
- `GET /api/fleet/runs/[id]`.
- Draft-run create shell: name/goal/repo/budget/model/concurrency/review-policy
  fields persisted as a draft run, with no planner execution and no worker
  spawning.
- Approval preview shell: shows the not-yet-approved draft settings and explains
  which gates will be required later, without enabling approval of executable
  work.
- Minimal Fleet Management view listing runs and task graph from seeded or
  imported existing data.
- `data/fleet/keys.ts`, `data/fleet/queries.ts`, and DTOs that keep client code
  away from server-only modules.

Definition of done:

- Unit and DB tests pass.
- No worker spawning yet.
- Operator can open Fleet Management, see an empty state, create a draft run,
  view an approval preview, and inspect a read-only run graph over seeded or
  imported data.
- Existing build/test gate green.
- Client import tests prove the Fleet UI does not import server-only modules.

### Phase 2: Plan ingestion and decomposition

Deliver:

- Create run from markdown/free-text goal.
- Planner output parser.
- Conversion from planner tasks to durable `fleet_tasks`.
- Plan review screen.
- Operator approval endpoint.

Definition of done:

- Can create a draft run and approve a task graph without launching workers.
- Plan critics can attach findings as artifacts.

### Phase 3: Scheduler and worker launch

Deliver:

- Reconciler tick.
- Ready-task selection.
- Transactional leases and idempotent spawn protocol.
- Startup recovery before any launch.
- Resource admission controller.
- Concurrency/provider caps.
- File-claim conflict avoidance.
- Fleet-specific fail-closed wrapper around `spawnWorker`.
- Worker prompt template.
- Worker/session linkage through `fleet_workers`.
- 40 fake-worker performance test.

Definition of done:

- A two-task independent run launches two workers.
- Conflicting tasks do not launch concurrently.
- Duplicate ticks do not duplicate workers.
- Restart recovery reconciles active/leasing/spawning tasks before launch.
- Write tasks fail if no isolated worktree is created.
- Pause stops new launches.
- Cancel mode behavior is persisted and restart-safe.
- Fake 40-task run remains responsive with bounded polling/event writes.

### Phase 4: Artifact contract and status aggregation

Deliver:

- Fleet-owned `$STOA_HOME/fleet/<run>/<task>/<attempt>/report.md`,
  DB-backed artifact read, or MCP report submission.
- Report schema/nonce/task/attempt/base/head validation.
- Diff summary artifact.
- Actual-claim recomputation from git diff.
- Event timeline.
- Lazy worker output fetch.
- Missing-report handling.

Definition of done:

- Workers reach a terminal worker status only after report/diff collection or a
  clear terminal cause; the task transitions to `needs_inspection` when the
  report/diff is missing, stale, malformed, or claim-drifting.

### Phase 5: Verify and review gates

Deliver:

- Task verification command support.
- Reviewer task generation.
- Blocking findings create fix tasks.
- Task state loops: running -> verifying -> reviewing -> fixing/ready.
- Reuse/extract dispatch verification runner.
- Four mandatory independent review dimensions.

Definition of done:

- A task cannot become `ready_to_merge` with failed verification or blocking
  findings.
- A task cannot become `ready_to_merge` without four clean independent reviews
  when it changes implementation/docs/config.

### Phase 6: Merge integration

Deliver:

- Fleet grouping over dispatch auto-merge/merge-train.
- Dependency-order landing.
- Conflict detection.
- Re-verify after integration.
- PR/branch handoff where configured.

Definition of done:

- A multi-task run lands green disjoint changes in order.
- Conflict tasks stop and request operator input.
- Verified/reviewed SHA pinning prevents stale merges.

### Phase 7: Lifecycle hardening

Deliver:

- Provider backoff.
- Worktree cleanup UI.
- Run archival.
- Retention policies.
- Historical analytics.
- Advanced cloud/offloaded worker hooks.

Definition of done:

- Archived runs keep audit trails without unbounded artifact growth.
- Cleanup is explicit, scoped, and restart-safe.

### Phase 8: AI supervisor layer

Deliver:

- Optional conductor/supervisor task that reads durable summaries.
- Supervisor recommendations for re-planning, retries, grouping, and merge
  ordering.
- MCP tools for fleet run control.

Definition of done:

- Supervisor can help manage the run, but killing/closing it does not lose run
  truth.

## Migration from existing systems

Pipeline:

- Keep current pipeline API stable.
- Later, allow pipeline specs to be imported into Fleet Management.
- Do not make existing in-memory pipeline behavior durable in the same PR as
  Fleet Management v1 unless it is necessary.

Dispatch:

- Reuse claim parsing and task decomposition ideas.
- Do not change existing dispatch rows into fleet tasks automatically.
- Add explicit "Promote to fleet run" action later.

Fleet Board:

- Keep it as cross-run lifecycle overview.
- Link Fleet Board cards to fleet runs/tasks when applicable.
- Add Fleet Management as a focused run execution view.

MCP:

- Keep current orchestration tools.
- Add fleet tools that operate on durable run ids instead of session-only worker
  sets.

## Answer to the 40-agent question

Can Claude or Codex MCP conductor pattern manage 40 agents working on a plan?

It can help coordinate them, but it should not be the only mechanism. With the
current Stoa implementation, a conductor can spawn/list/message workers and run
pipelines, but the durable truth is incomplete for 40-agent work. Current Codex
subagent docs also default to far fewer concurrent threads and caution against
write-heavy parallelism.

The reliable design is:

- Server-side fleet scheduler for truth and lifecycle.
- Agents as workers/reviewers/planners.
- Conductor as optional supervisor over summaries.
- Operator UI for approval and intervention.
- Git worktrees/branches/PRs for audit and merge safety.

That is the product Stoa is missing.

## Open questions

- Should Fleet Management default to local workers or support cloud/offloaded
  workers in v1?
- Should the first merge integration be local-only, GitHub PR-based, or both?
- Should planner output be JSON-only, markdown-plus-frontmatter, or a typed
  tool call?
- What is the safe default max parallelism on Windows with Tier 2 pty-host?
- Should tasks be allowed to share a worktree at all, or should shared worktrees
  remain pipeline-only?

## First PR checklist

- Add `lib/fleet/types.ts`.
- Add pure `lib/fleet/engine.ts`.
- Add migration/schema for `fleet_runs`, `fleet_tasks`,
  `fleet_task_dependencies`, `fleet_task_claims`, `fleet_workers`,
  `fleet_artifacts`, and `fleet_events`.
- Include lease, scheduler epoch, approval hash/state, budget reservation,
  recovery, spawn correlation, attempt, cleanup, and session FK fields.
- Add typed queries under `lib/db/queries/fleet.ts`.
- Add adapter fields/queries linking fleet runs/tasks to existing sessions,
  dispatch rows, pipeline runs, and Fleet Board/Verdict Inbox data.
- Add `data/fleet/keys.ts`, `data/fleet/queries.ts`, API DTOs, and client import
  tests.
- Add unit tests for state transitions and scheduling.
- Add DB tests for run/task/artifact/event persistence.
- Add minimal `GET/POST /api/fleet/runs`.
- Add draft-run create shell and approval-preview shell with no planner
  execution and no worker spawning.
- Add minimal Fleet Management pane route/view behind existing fleet nav
  patterns, centered on attention queue and run graph.
- Add authority/approval/audit-event tests.
- Do not spawn workers in the first PR.

This creates the durable spine. After that, worker launch and merge safety can
land in smaller, reviewable slices.
