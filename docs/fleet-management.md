# Fleet Management Plan

Last updated: 2026-08-01

## Executive summary

The current delivery branch implements the durable Fleet delivery loop described
by this plan: a high-level epic, project specification, imported plan, pipeline,
Builder workflow, or Dispatch source can become a bounded task graph; installed
unattended-capable providers are allocated automatically; worktree-isolated
workers report results; Stoa verifies and independently reviews each exact head;
bounded fix rounds can run;
and a fully green integration can land through a local fast-forward or a
GitHub PR with exact-head CI checks. Automatic plan approval, automatic start,
automatic fixes, and automatic merge are explicit opt-in policy choices. A user
does **not** have to create an initial interactive session: Fleet creates its
planner, critic, worker, reviewer, and fixer sessions as the durable state
machine needs them. The current shared Git/provider-home layout is deliberately
not advertised as strong OS confinement: unattended Fleet launches require the
operator's explicit `allowUnconfinedAgents` consent until per-attempt Git metadata
and provider state are isolated. This remains release-candidate work until the repository
gate, independent reviews, PR-head OS matrix, and merge recorded in the phase
ledger are all complete.

The implementation also migrates Stoa's orchestration server to the MCP
TypeScript SDK v2 and current date-versioned protocol negotiation. Direct Fleet
MCP operations require server-issued, narrowly scoped capabilities; human
approval and merge authority are never inferred from an agent request. The
status ledger below distinguishes implementation on the current delivery branch
from the final repository gate, CI, and merge evidence.

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
- the repository-required four-agent review gate is clean,
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
6. Run the local gate: `npx prettier --check .`, `npx tsc --noEmit`,
   `npm test`, `npm run build`.
7. Run the repo-required four-agent review gate:

   - correctness/security,
   - conventions/cross-platform,
   - simplicity/UX,
   - adversarial red-team.

   Runtime Fleet plans and task results use the same four distinct dimensions;
   their exact-head evidence is separate from this repository diff review.

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
- 4 review agents for the mandatory repository gate.
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
- Durable Fleet Management in the authenticated UI/API: create/import runs,
  generate and allocate plans, opt into exact automatic approval/start/fix/merge,
  inspect tasks/workers/evidence/supervisor/merge state, intervene, archive, and
  clean exact owned worktrees.
- Scoped direct Fleet MCP reads and lifecycle mutations backed by server-issued
  capabilities, plus the informational-only `fleet_request_action` bridge for
  agents that do not hold delegated authority.

The server uses `@modelcontextprotocol/server` 2.0.0: SDK major v2, which should
not be confused with a protocol named "MCP 2.0." Its stdio entry uses
`serveStdio`, serves native 2026-07-28 requests, and tests legacy `initialize`
negotiation at 2025-11-25 through `legacy: "serve"` for existing Claude, Codex,
Hermes, Kilo, and Kimi configurations. There are no remaining imports from the
monolithic v1 `@modelcontextprotocol/sdk` package.

Orchestration-enabled sessions use each provider's native MCP surface. Claude
updates the project-local `.mcp.json`; Codex persists complete, session-scoped
`-c mcp_servers.stoa.*` launch arguments instead of changing global config;
Hermes maintains a global `stoa` registration; Kilo updates `.kilo/kilo.json`;
and Kimi updates `.kimi-code/mcp.json`. Every generated stdio command invokes
Stoa's absolute Node executable and pinned local `tsx/dist/cli.mjs` directly, so
it is offline-capable and cannot resolve or execute a project-local `npx`/`tsx`.

Claude, Kilo, Kimi, and Hermes configs are identity-generic. Each conductor
agent process receives `STOA_CONDUCTOR_SESSION_ID=<its Stoa session id>` through
both PTY and tmux launch paths; provider-native interpolation maps that value to
the MCP child's `CONDUCTOR_SESSION_ID`. Two conductors can therefore share one
working directory without rewriting the config to each other's identity. A
literal unresolved placeholder is an invalid authoritative binding and cannot
be bypassed with a tool-supplied conductor id. The old git-excluded
`.stoa-conductor` file remains read-only compatibility fallback behavior; new
Hermes sessions do not write it.

Valid project configs retain unrelated keys, use atomic writes, and keep
generated paths locally git-excluded. Claude, Kilo, and Kimi all fail closed on
malformed or structurally incompatible JSON and leave the original file
byte-for-byte intact. Stoa updates an existing `stoa` entry only when its
ownership marker is present; an unowned project entry, or a listed global Hermes
entry without the exact recorded Stoa identity, is preserved and reported as a
409 conflict rather than removed or overwritten. Transient Hermes discovery
failures remain best-effort, and `POST /api/sessions/[id]/mcp-config` can repair
an existing session.

Any orchestration-enabled Claude, Codex, Hermes, Kilo, or Kimi session can act
as a conductor, and workers get their own git worktrees. Kilo remains fully
interactive and MCP-capable, but is not eligible for unattended Fleet execution
until its launched command surface has a verified auto-approve mode.

### Existing worker lifecycle

`lib/orchestration.ts` already does most of the hard local work:

- Accepts server-owned launches without a conductor and validates the conductor
  when one is supplied.
- Creates a git worktree when requested.
- Creates a worker session row linked to `conductor_session_id`.
- Starts the provider through the session backend.
- Waits for a ready prompt.
- Sends the task.
- Tracks worker status and supports follow-up, completion, failure, and kill.

Interactive session creation can attach an orphaned Stoa-managed worktree that
still exists on disk, such as after interrupted or failed cleanup. The selector
orders orphaned worktrees first and disables entries still attached to an active
session. For every attach, including projectless sessions, the server requires
the candidate to be Stoa-managed, registered by Git as a live worktree of the
exact same repository, and still on disk; it trusts the registered branch rather
than client-supplied branch data. Reattachment skips worktree creation and
environment setup, preserving the existing branch, files, and installed
dependencies. It reuses an existing checkout; it cannot recreate a worktree
that has already been deleted.

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

### Current implementation snapshot (2026-08-01)

Implemented on `feat/fleet-autonomous-delivery`:

- First-class durable `fleet_runs`, tasks, dependencies, claims, workers,
  artifacts, events, approvals, leases, reservations, verification records,
  four-lane plan/task reviews, fix attempts, merge integration, cleanup,
  retention, capability audit, and restart-recovery state in SQLite.
- Goal/spec-first creation plus explicit import adapters for Markdown task plans,
  PipelineSpec, Builder/saved workflows, and Dispatch plan/issue payloads. Fleet
  can create a bounded planner session or ingest an already structured graph.
- Deterministic automatic allocation across installed, unattended-capable agent
  CLIs. Valid planner suggestions are honored; missing/unavailable suggestions
  are balanced across eligible providers. Kilo remains available for ordinary
  interactive Stoa sessions and provider-native MCP, but its bare TUI has no
  verified auto-approve mode, so Fleet never assigns it to a planner, critic,
  worker, reviewer, or fixer. The current unattended Fleet set is Claude, Codex,
  Hermes, and Kimi, derived from each registry entry's verified nonempty
  auto-approve flag. Automatic planning and source imports fall back from Kilo
  to an installed eligible provider. A manually persisted Kilo assignment is
  not silently rewritten and fails at the final spawn boundary. Pre-upgrade
  spawning or running planner, critic, reviewer, and fixer rows are rejected
  before activation or polling during restart recovery, and their owned
  sessions/worktrees are stopped and cleaned. With no eligible provider,
  planning leaves the draft intact and creates no planner/task graph;
  imports fail atomically with `409` before run/task persistence. A model is
  inherited only when it belongs to the same provider, preventing foreign-model
  leakage. Hermes remains a free-text model provider, but at session/worker
  launch an empty, missing, or foreign static Claude/Codex model resolves to
  Stoa's explicit Hermes default, `kimi-k3`; a genuine Hermes free-text model is
  preserved. Imported Markdown, Pipeline, Builder, and Dispatch graphs use the
  same eligible-provider allocation, and project imports resolve their actual
  configured/default base branch rather than assuming `main`.
- An opt-in automation policy for exact four-lane plan approval, automatic
  start, sensitive-path consent, unconfined-agent consent, bounded fix rounds,
  local or GitHub merge, cleanup behavior, planner task cap, and retention. Each
  transition rechecks the plan, execution, policy, base, and current-head hashes
  with compare-and-set updates before authority is exercised. Automatic fix and
  merge are independently granted; clean work can merge without granting an
  agent permission to repair findings.
- A restart-aware server scheduler with startup reconciliation, transactional
  leases, idempotent spawn, dependency/file-claim admission, provider/run/local
  concurrency caps, deterministic backoff, conservative budget reservation,
  pause/cancel behavior, and a framework-neutral remote-executor seam. A failed
  startup recovery is retried without overlap; every launch-capable loop remains
  closed until it succeeds. While blocked, only persisted planner polling and
  lifecycle/cancellation cleanup continue; verification, review/fix, merge,
  automation admission, and worker scheduling remain closed.
- Fleet-owned nonce/attempt-bound reports and Git-derived base/head/diff/claim
  evidence. Worker prose is retained as testimony; server-observed Git state is
  authoritative.
- Direct-argv verification with bounded output/time, cross-platform executable
  resolution, clean-worktree enforcement, exact-head records, and recovery.
  Shell metacharacters are rejected; `&&` is parsed only as a sequence of direct
  commands.
- Four independent exact-head result-review lanes. Blocking findings may enter
  policy-authorized bounded fix rounds; each descendant head is re-verified and
  receives four fresh reviews before it can become merge-ready. Planner,
  reviewer, and fixer launches retry only transient/rate-limit failures after
  exact ownership-safe cleanup: at most three failures, with deterministic
  exponential backoff from 5 seconds capped at 5 minutes. Registry-deterministic
  installed unattended-provider fallback clears foreign models across restarts.
- A dependency-ordered merge runtime with separate durable staging and landing
  boundaries. Internal integration and final verification run under the exact
  approved execution without consuming external merge authority. Only the
  exact final verified integration head may atomically consume the one-shot
  landing authorization, after which Fleet supports either an exact clean local
  fast-forward or a no-force GitHub push, PR, required-check wait, exact-head
  check, and merge.
- Explicit archival and exact-ownership cleanup, bounded artifact pruning,
  retention metadata, outcome/cost analytics, and operator task/worker controls.
  Lifecycle safety events bypass exhausted data-plane event quotas, so archive
  and external cleanup completion cannot be rolled back after a filesystem side
  effect. Cost sampling and hard-stop interrupts cover planner, plan-review,
  worker, task-review, and fixer sessions in every nonterminal run phase.
- An optional, advisory AI supervisor over deterministic hash-bound snapshots.
  Recommendations are immutable evidence only; the SQLite state machine remains
  authoritative and a recommendation cannot execute work or mint approval.
- MCP SDK v2 with current/legacy date-version negotiation and direct scoped
  Fleet tools. Admin HTTP routes issue/revoke hash-only stored capabilities;
  reusable `fleet:read` tokens are run-scoped (with `*` reserved for listing),
  and mutation tokens are one-use and bound to the exact action, run/task/worker,
  attempt, and relevant plan/execution/head/artifact hash. Scheduler ticks,
  worker kills, and destructive cleanup are deliberately not advertised over
  MCP.

Delivery status:

- The feature implementation and focused subsystem tests are complete on the
  working branch. The phase ledger is updated as integration evidence lands.
- Repository-wide typecheck/tests/build, four independent final diff reviews,
  the GitHub OS matrix, and the final merge are release gates, not optional
  follow-ups.
- MCP protocol-native Tasks are not advertised because the SDK does not expose
  the draft extension used by Fleet. Subscriptions are replaced by bounded
  polling plus full snapshot refetch after reconnect. Sampling is not advertised
  because it is deprecated by the negotiated 2026-07-28 protocol. These are
  intentional protocol choices rather than unfinished Fleet state handling.
- The stdio server advertises only capabilities it implements: tools. It does
  not advertise resources or prompts, so clients cannot mistake optional MCP
  surfaces for available Fleet functionality.

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

### Epic/spec to merged result

No initial interactive session is required. In Fleet Management:

1. Select a repository/project and paste the epic or high-level specification.
2. Leave **Plan automatically** enabled, choose a planner task cap, and (until
   strong per-attempt Git/provider isolation is available) explicitly consent to
   any unattended planner/reviewer/worker launch.
3. Opt into **Approve plans automatically** to require four exact, independent,
   clean plan reviews instead of a manual approval click.
4. Opt into **Start approved work automatically**. The same explicit unattended-
   agent consent governs planners, critics, workers, task reviewers, and fixers;
   enabling automatic planning alone never silently grants it.
5. Optionally enable bounded automatic fixes for review findings. Independently,
   opt into automatic local or GitHub merge; merge authority does not imply fix
   authority, and a non-clean run simply waits.
6. Create the run. Stoa creates every planner/critic/worker/reviewer/fixer
   session itself, allocates installed unattended-capable providers, and advances
   the durable state
   machine until completion or a fail-closed attention condition.

An imported Markdown/PipelineSpec/Builder/Dispatch plan skips planner-session
creation but uses the same exact approval, execution, verification, review, and
merge gates. Turning the automatic options off preserves the manual workflow.

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

A fleet run is one project-scale execution. The lists and SQL sketch in this
design section are historical/conceptual; `lib/fleet/types.ts`,
`lib/db/schema.ts`, and migrations are the authoritative current contract. A
run may start from:

- A free-text goal.
- A markdown plan.
- A Dispatch issue payload. Raw GitHub issue/milestone ingestion is not a
  separate Fleet adapter today.
- A dispatch planner output.
- A pipeline spec.
- A saved workflow template.

Conceptual statuses from the original design:

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

Conceptual statuses from the original design:

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

The current automatic planner and approval hash accept only `blocks` edges. The
other edge types remain intentional post-v1 design vocabulary and are rejected
from the current executable graph.

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

The following posture and SQL block record the original v1 design. They are not
a copy of the live schema; the current additive tables, columns, indexes, and
state values are defined by `lib/db/schema.ts` plus `lib/db/migrations.ts`.

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

Fleet Management v1 uses these adapter boundaries:

- A run records imported lineage in `source_kind`, `source_id`, and
  `source_name`.
- A materialized Fleet task records source lineage in `source_ref`,
  `source_step_id`, `source_issue_id`, and `source_issue_number` where
  applicable. Imports create Fleet-owned durable tasks rather than wrapping
  live Dispatch or Pipeline runtime rows.
- `fleet_workers.session_id` links to the existing `sessions` table.
- Verification uses the extracted shared direct-argv runner in
  `lib/verification/runner.ts` through Fleet's durable verification runtime.
- Merge uses Fleet's durable `merge-runtime.ts`, reusing Dispatch's exact PR
  merge/SHA invariants rather than Dispatch auto-merge/merge-train state.
- Fleet Board is integrated as the cross-run lifecycle overview and links into
  Fleet runs/tasks. Verdict Inbox remains the existing dispatch/ceremony
  surface; Fleet Management uses its own durable attention queue rather than
  claiming a new Verdict Inbox integration.

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

The implemented pure scheduler core includes:

- `lib/fleet/types.ts`
- `lib/fleet/engine.ts`
- `lib/fleet/conflicts.ts`
- `lib/fleet/budgets.ts`
- `lib/fleet/prompt.ts`

The implemented side-effecting runtime modules include:

- `lib/fleet/scheduler.ts`
- `lib/fleet/spawn.ts`
- `lib/fleet/report-runtime.ts` and `lib/fleet/git-state.ts`
- `lib/fleet/verification.ts`
- `lib/fleet/plan-review.ts`, `lib/fleet/task-review.ts`, and
  `lib/fleet/task-fix-runtime.ts`
- `lib/fleet/merge-runtime.ts`
- `lib/fleet/lifecycle.ts`
- `lib/fleet/status-runtime.ts`

The pure engine answers:

- Which tasks are ready?
- Which ready tasks can run together without claim conflicts?
- Which tasks are blocked by failed dependencies?
- Which tasks exceed retry limits?
- Whether a run is complete, failed, paused, or waiting for operator input.
- Whether budgets permit another launch.
- Whether a task should be verified, reviewed, fixed, merged, or marked failed.

The scheduler reconciler:

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

Restart recovery ships with worker launch, not later. At process start, and
before any explicit `/tick` or automatic loop can launch a planner, reviewer,
fixer, or worker, Stoa:

- Mark active fleet runs `recovery_required = 1`.
- Reconcile workers in `leasing` or `spawning` by `spawn_request_id`.
- Check whether linked `sessions(id)` still exist.
- Check last observed status through the session backend/status detector.
- Expire stale leases.
- Preserve orphaned worktrees for inspection.
- Refuse to spawn replacements until each active run is either recovered,
  paused for operator input, or canceled.

If the first recovery attempt fails, a busy-guarded controller retries it on a
bounded cadence. Only persisted planner polling and lifecycle/cancellation
cleanup are allowed while blocked. Recovery success arms exactly one
planner/automation loop and one execution loop; shutdown owns and clears all
recovery/runtime timers.

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

A task launches only after all required resources are reserved. Transient
session/provider/transport/Git slots are released when work ends. Preserved
worker worktree and disk leases remain charged until exact, explicit
archived-run cleanup; preservation is not a way to bypass lifetime capacity.

## Concurrency model for 40 agents

Separate total plan size from active concurrency.

Recommended defaults:

- `max_total_workers`: 40.
- `max_parallel_workers`: 6 locally.
- `max_parallel_workers` warning threshold: 12.
- Default lifetime capacity: 48 worktrees per repository and 32 GiB of
  Fleet-owned worktree disk, with a retained-worker ceiling of 40 and reserved
  headroom for reviewers and integration. The configurable worktree ceiling is
  64; this does not raise the six-session active default.
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

Required completion report: each worker writes exactly one bounded JSON object
to `$STOA_HOME/fleet/<run-id>/<task-id>/<attempt>/report.json`:

```json
{
  "schemaVersion": 1,
  "runId": "<run id>",
  "taskId": "<task id>",
  "workerId": "<worker id>",
  "attempt": 1,
  "spawnRequestId": "<spawn request id>",
  "nonce": "<attempt nonce>",
  "baseSha": "<full approved base SHA>",
  "headSha": "<full resulting head SHA>",
  "submittedAt": "<ISO-8601 timestamp after spawn>",
  "status": "succeeded",
  "summary": "What changed and why",
  "filesChanged": ["src/example.ts"],
  "verification": [
    {
      "command": "npm test",
      "result": "pass",
      "evidence": "<bounded result summary>"
    }
  ],
  "risks": [],
  "followUps": [],
  "mergeReadiness": "ready",
  "markdown": ""
}
```

The runtime opens the exact attempt path without following links, requires a
regular bounded file, validates every run/task/worker/attempt/spawn/nonce/base/
head/time binding, and persists the accepted or invalid result as durable
evidence. It independently reads the clean worktree, exact Git head, changed
files, claims, and sensitive paths; worker prose and `filesChanged` remain
testimony rather than authority. Idle plus a missing, stale, malformed, or
claim-drifting report becomes `needs_inspection`, not success. Repo-relative
magic files are forbidden so reports cannot collide with user work or enter the
merge candidate.

Implemented MCP-facing operations are listed in the API section. Worker
completion reports use Fleet's nonce-bound artifact/runtime contract rather than
trusting a free-form MCP status update. Direct operator lifecycle tools use
server-issued scoped capabilities; informational `fleet_request_action` remains
available when an agent lacks that authority.

Reports are never sufficient for merge readiness by themselves. The server also
computes the diff, runs the extracted shared direct-argv verifier, checks exact
approval/head state, and attaches four independent review artifacts.

## Planning flow

### Step 1: Create run

Operator opens Fleet Management and enters:

- Goal or plan.
- Repository/project. For a selected repository, the form displays its
  configured base branch when available. For a selected project, Fleet resolves
  the actual repository base branch during ingestion, before the plan contract
  is approved. The create form does not accept an arbitrary branch string.
- Provider/model defaults.
- Max parallel workers.
- Budget/cost guard.
- Whether automatic exact-plan approval, automatic start, bounded automatic
  fixes, and automatic merge are enabled.
- Local fast-forward or GitHub PR/CI merge target.
- Explicit sensitive-path and unconfined-agent consent when applicable.
- Planner task cap, automatic-fix cap, cleanup policy, and retention period.
- For an imported Markdown task plan only, a default verification command for
  write tasks. Epic/spec input delegates decomposition to the planner, which
  emits verification commands for each task.
- Review gate.

### Step 2: Decompose

Stoa launches a dedicated planner session when the input needs decomposition.
An imported structured plan is ingested directly and does not need any initial
session.
Planner output is a structured plan, not free-form only:

- Tasks.
- Dependencies.
- File claims.
- Acceptance criteria.
- Suggested providers/models.
- Per-task verification commands.
- Risk notes.

Dispatch plan/issues, PipelineSpec, and Builder/saved-workflow inputs now adapt
into the same Fleet source contract. Dispatch keeps its own defaults; Fleet uses
an operator-configured planner cap with a hard ceiling of 40 tasks.

Current implementation: Fleet Management launches a dedicated planner session
in a Git-isolated worktree after the automation policy grants the applicable
agent-launch authority. The default cap is 8 and the hard ceiling is 40. The
planner writes a marker-delimited JSON contract to `PLAN.md`; Stoa opens one
non-blocking/no-follow handle, requires a regular file, and reads at most 128
KiB. It validates unique task keys, backward-only dependencies, bounded
non-glob claims, criteria, verification hints, and installed unattended-provider
suggestions, then stores a readable plan plus the durable graph. A concurrent
manual plan cannot overwrite an active planner; the operator must cancel it
first. A bounded server reconciler advances headless planners. Durable
`finalizing` and `cleanup_pending` states retain exact session, worktree,
project, and created-branch identity until cleanup succeeds after a valid
result, cancellation, failure, or the 15-minute runtime limit.

### Step 3: Adversarial plan review

Before approval, run four mandatory plan critics:

- Correctness/security.
- Conventions/cross-platform.
- Simplicity/UX and scope.
- Adversarial red-team.

Each critic produces immutable findings against the exact plan, execution
contract, automation policy, base head, and per-run nonce. Critics are isolated,
read-only, distinct sessions. Findings do not silently mutate the plan.

### Step 4: Exact plan approval

Show:

- Task graph.
- Expected files touched.
- Dependency lanes.
- Estimated worker count.
- Estimated max concurrency.
- Budget estimate.
- Review/merge policy.
- Known risks.

In manual/admin mode the operator can approve the exact plan and use explicit,
hash-bound controls to change concurrency or budget, skip an eligible closure,
require/release manual task launch, convert an eligible task to read-only, or
approve an exact observed claim expansion. Arbitrary in-place task-graph editing
is not exposed as a post-approval control; a material plan change requires a new
plan/hash and review.

In opt-in automatic mode, approval occurs only after all four independent plan
lanes are current and clean. Fleet compares the exact plan, execution, policy,
and base hashes, refuses unsafe/missing direct-argv verification for write tasks,
and fails closed on sensitive paths unless separately consented. Automatic start
then performs another compare-and-set check before the scheduler may lease any
worker. This is the critical unattended path from an epic/spec to execution; it
does not require a user-created conductor session.

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

- Run configured verification through the extracted shared verifier. Store
  normalized argv/spec, not arbitrary shell text.
- Run four independent review dimensions for every implementation/docs/config
  change before merge readiness: correctness/security,
  conventions/cross-platform, simplicity/UX, and adversarial red-team.
- Ensure reviewer independence: the implementing worker or same session context
  cannot be the only reviewer for its own work.
- Record findings.
- If blocking findings exist, preserve the evidence and either require operator
  action or run a policy-authorized bounded fix attempt in the same owned
  worktree. A new descendant head invalidates all prior current-head evidence.
- Automatic fix rounds address blocking review findings only. A verification
  failure remains fail-closed for explicit retry/operator action; it is not
  silently turned into an AI fix request.
- If clean, mark `ready_to_merge`.

### Step 8: Merge

Fleet uses a Fleet-specific durable merge runtime while preserving the proven
Dispatch invariants: SHA pinning, stale-head refusal, readiness checks,
verification verdicts, dependency order, no-force publication, and explicit
worktree ownership/cleanup. Merge leases and progress survive restart.

- Keep the approved base SHA pinned. If the configured/GitHub base moves, stop
  before merge and require a refreshed plan/run and fresh exact evidence; Fleet
  does not silently rebase already-approved work.
- Detect conflicts while applying each exact task head to the integration
  worktree.
- Run verification after applying each task.
- Merge in dependency order.
- Preserve per-task branches/worktrees for auditability and create one bounded
  integration result for the run.
- Keep approval controls, pause, and cancel available during internal staging.
  Atomically revalidate the run, desired state, approved execution, graph,
  claims, policy, pinned base, final verification, and exact integration head
  before consuming external landing authority. Once that authority is consumed,
  exact approval controls and pause/cancel fail closed because an OS Git or
  GitHub landing cannot be canceled atomically after it starts.
- Produce one ordered integration result for the run. Per-task, batch, and
  milestone PR strategies remain future options rather than implemented modes.
- For GitHub, push without force, open/reuse the exact integration PR, wait for
  configured checks on that exact head (an empty rollup means none are
  configured), require an explicitly accepted successful conclusion for every
  reported check (unknown/stale conclusions fail closed), and merge only if
  both head and pinned base are unchanged.
- For local landing, require an unchanged clean checkout and exact
  fast-forward; never overwrite unrelated user work.

## API plan

### Authority model

Authenticated admin HTTP routes are the operator control plane. Delegated MCP
tools use explicit, server-issued capabilities:

- `fleet:read`: reusable, exact-run read access; the reserved run id `*` permits
  only run listing.
- `fleet:create`, `fleet:plan`, `fleet:approve`, `fleet:start`, `fleet:pause`,
  `fleet:resume`, `fleet:cancel`, `fleet:submit-artifact`, and `fleet:merge`:
  one-use actions bound to the exact action intent and relevant hash.
- Capability issuance and revocation are admin-only HTTP operations. Only a
  token digest and immutable audit evidence are stored; plaintext is returned
  once and never logged or persisted.

Rules:

- A human/admin must issue delegated `approve`, `resume`, `cancel`, and `merge`
  capabilities. Worker kill and destructive cleanup are not MCP tools.
- MCP tools may request approvals and present recommendations, but cannot grant
  themselves approval authority.
- Every capability issue, revoke, claim, success, and failure writes immutable
  hash-only audit evidence. Fleet lifecycle changes also retain their normal
  actor and state-transition events.
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
- The final integration/merge request and any changed integration head.
- Budget increase or hard-budget override.

The UI must show "approved vs current" diffs and explain why the approval is
required.

Implemented routes:

- `GET /api/fleet/runs`
- `POST /api/fleet/runs`
- `GET /api/fleet/runs/[id]`
- `POST /api/fleet/runs/import`
- `POST /api/fleet/runs/[id]/plan`
- `POST/GET/DELETE /api/fleet/runs/[id]/generate`
- `POST /api/fleet/runs/[id]/approve`
- `GET /api/fleet/runs/[id]/approvals/preview`
- `POST /api/fleet/runs/[id]/pause`
- `POST /api/fleet/runs/[id]/resume`
- `GET/POST /api/fleet/runs/[id]/cancel` (no-store exact destructive preview /
  digest-bound mutation)
- `POST /api/fleet/runs/[id]/artifacts`
- `GET /api/fleet/runs/[id]/artifacts/[artifactId]` (lazy body read)
- `POST /api/fleet/runs/[id]/controls/budget`
- `POST /api/fleet/runs/[id]/controls/concurrency`
- `POST /api/fleet/runs/[id]/tasks/[taskId]/retry`
- `POST /api/fleet/runs/[id]/tasks/[taskId]/claims/approve`
- `POST /api/fleet/runs/[id]/tasks/[taskId]/controls/manual-launch`
- `POST /api/fleet/runs/[id]/tasks/[taskId]/controls/read-only`
- `POST /api/fleet/runs/[id]/tasks/[taskId]/controls/skip`
- `POST /api/fleet/runs/[id]/tasks/[taskId]/verification`
- `POST /api/fleet/runs/[id]/tasks/[taskId]/review`
- `POST /api/fleet/runs/[id]/workers/[workerId]/message`
- `POST /api/fleet/runs/[id]/workers/[workerId]/kill`
- `POST /api/fleet/runs/[id]/workers/[workerId]/complete`
- `GET /api/fleet/runs/[id]/workers/[workerId]/output` (bounded lazy read)
- `GET/POST /api/fleet/runs/[id]/merge`
- `GET/POST /api/fleet/runs/[id]/supervisor`
- `POST /api/fleet/runs/[id]/archive`
- `GET/POST /api/fleet/runs/[id]/cleanup` (no-store exact cleanup preview /
  digest-bound queue)
- `GET /api/fleet/analytics`
- `POST /api/fleet/capabilities`
- `DELETE /api/fleet/capabilities/[id]`
- `POST /api/fleet/capabilities/action` (capability-authenticated boundary)
- `POST /api/fleet/runs/[id]/tick` (scheduler-internal; never an MCP tool)

Implemented scoped MCP tools:

- `fleet_list_runs`
- `fleet_get_capabilities`
- `fleet_create_run`
- `fleet_plan_run`
- `fleet_approve_run`
- `fleet_get_run`
- `fleet_list_tasks`
- `fleet_supervisor_snapshot`
- `fleet_start_run`
- `fleet_pause_run`
- `fleet_resume_run`
- `fleet_cancel_run`
- `fleet_submit_artifact`
- `fleet_merge_run`

`fleet_get_capabilities` is side-effect-free public metadata. Each other direct
Fleet tool presents the opaque token and its exact public scope to the isolated
capability action boundary. `fleet_request_action` remains informational-only:
it creates operator attention but never executes the requested action. The
general `request_operator_input` tool can ask a question, but its answer is not
authorization. Scheduler tick, worker message/kill, retry, forced verification,
forced review, archival, and destructive cleanup are deliberately not
advertised as direct MCP tools.

This is an MCP tool-policy boundary, not an OS sandbox against arbitrary local
processes. A fully trusted, unconfined local agent can still reach resources
available to its OS identity. Remote deployments must enable Stoa
authentication, and host-level separation remains necessary for a strong
human-only boundary. Scoped capabilities reduce delegated HTTP authority; they
do not pretend that UI headers or elicitation IDs are an OS sandbox.

The current bubblewrap worker wrapper is **not** accepted as strong Fleet
confinement: a linked worktree needs shared Git metadata, provider homes contain
persistent executable configuration, and an inherited network can reach a
loopback-trusted Stoa server. Fleet therefore fails closed instead of using the
prompt-bypass flag unless `allowUnconfinedAgents` was explicitly approved in the
hash-bound automation policy. `STOA_REQUIRE_AUTH=1` is still required for secure
network deployments, but it does not by itself solve shared Git/provider state.
Per-attempt Git metadata and provider-state isolation are a future hardening
prerequisite before this consent can be omitted.

## UI plan and current surface

Fleet Management is implemented as a focused run-execution view distinct from
the cross-run Fleet Board. Fleet Board cards can hand off directly to the exact
Fleet run/task; Fleet Management owns the durable attention queue and drilldown.

Current Fleet Board answers:

> "What autonomous work exists across lifecycle lanes?"

Fleet Management answers:

> "How is this project-scale plan executing, what needs attention, and what is
> safe to merge?"

The primary screen is an attention queue rather than six equally loud
dashboards. Its deterministic severity tiers put exact approval, security,
automation/recovery, hard-budget, and integration blockers first; verification
failures, blocking reviews, and claim drift next; then operator questions,
worker failures, cleanup/backoff state, and warnings. Graphs, task cards, worker
evidence, timelines, artifacts, and merge state are drill-downs from that queue.

### View structure

The implemented top bar provides:

- Run selector.
- Status.
- Pause/resume/cancel.
- Exact concurrency and budget/hard-stop approval controls.
- Budget/cost badge.
- Needs-attention badge.

The implemented run surface provides:

- Plan graph / DAG.
- Task board.
- Worker table.
- Event timeline.
- Bounded lazy artifact and rendered-output reads bound to the exact run,
  worker/session, and attempt.
- Merge queue.
- Advisory, hash-bound supervisor evidence.
- Exact task controls for skip closure, manual launch, read-only conversion,
  and claim expansion; every mutation shows its approved/current bindings.
- Fleet Board handoff into the exact run/task and back to the cross-run lanes.

Task cards provide:

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

Worker evidence provides:

- Session id.
- Provider/model.
- Status from status detector.
- Task.
- Worktree.
- Last heartbeat.
- Last output summary.
- Tokens/cost when available.

The operator attention queue includes:

- Blocked questions.
- Review findings requiring decision.
- Merge conflicts.
- Budget/rate-limit stops.
- Failed verification.
- Security/secret findings.
- Claim drift.
- Stale/dead workers.

Approval/pause/cancel controls remain available during internal integration
staging. Once exact external landing authority is consumed, the UI locks those
controls and shows the durable landing state. Bulk actions are allowed only when
they are safe and previewable. Destructive actions require exact confirmation
and show affected owners, worktrees, branches, artifacts, and expected data
loss.

### Mobile behavior

Because Stoa is mobile-first, the implemented view provides:

- One-column run summary.
- A five-section switcher: Plan, Tasks, Workers, Events, Merge.
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
- Stop mode: `pause-new`, `hard-stop`, or `ask-operator`.

Scheduler behavior:

- Before spawning, reserve budget from a conservative estimate based on task
  type/model/provider and prior run history.
- Decrement available budget by reservations before launch; release unused
  reservation on completion.
- If cost telemetry is missing or low-confidence and the run is in hard-budget
  mode, do not launch more workers.
- In every nonterminal run phase, sample and enforce cost for planner,
  plan-review, worker, task-review, and fixer accounts.
- If a run exceeds warning threshold, emit event and show UI warning.
- If it reaches hard budget, pause and stop launching new tasks.
- In `pause-new` mode, leave already active paid sessions running. In
  `ask-operator` mode, pause for an explicit decision. In `hard-stop` mode,
  durably request graceful interruption of every exact-owned active paid
  session, then stop sessions that continue spending beyond the configured
  grace period.
- A budget-exhausted run cannot resume until an exact approval raises the
  relevant budget, explicitly overrides the persisted hard stop, and all
  interrupt cleanup has resolved.
- Track provider rate-limit cooldowns as scheduler state.
- Prefer mini/low-cost models for read-only scans where configured.

This directly addresses the risk that a 40-agent fleet can turn one operator
action into an expensive burst.

## Pause and cancel semantics

Operators must choose explicit modes:

- `pause-new`: stop all new Fleet launches while currently active paid sessions
  continue. Pause is accepted only for `running`, `reviewing`, or `merging` runs
  before external landing authority is consumed; draft planning uses the
  planner-cancel control instead.
- `pause-and-interrupt`: stop launching and ask every active Fleet-owned paid
  session (planner, plan reviewer, worker, task reviewer, or fixer) to reach a
  safe stopping point with a report, then durably stop sessions that outlive the
  grace period. Exact session ownership and interrupt intent are persisted
  before delivery; an earlier budget interrupt cause/deadline is preserved.
- `cancel-preserve-worktrees`: stop and settle active workers, plan reviewers,
  task reviewers, and fixers while preserving branches, worktrees, artifacts,
  and events for inspection. An active planner must first be canceled through
  `DELETE /api/fleet/runs/[id]/generate` and finish its exact cleanup; the run
  cancellation endpoint never performs that separate destructive planner
  cleanup implicitly. Preserved integration worktrees/branches remain evidence;
  later archived cleanup is intentionally limited to exact worker, reviewer,
  and fixer worktrees and does not silently broaden into integration cleanup.
- `cancel-and-clean-owned-worktrees`: destructive cleanup of fleet-owned
  worktrees after `confirm=true`, a confirmation string exactly equal to the run
  id, and the SHA-256 digest from a complete no-store preview. The server rebuilds
  the canonical target set, compares its database revision inside the mutation
  transaction, and persists/queues only those confirmed paths. Its integration
  worktree and branch are listed as deleted targets and remain bound to the
  confirmed repository path and expected head.

Destructive previews show at most 128 owners/sessions/worktrees/branches. A
larger target set is incomplete and the POST fails closed; preserve-cancel stays
available. Preserved artifact display may be truncated without invalidating the
destructive target digest because artifacts are not removed by these actions.

Both cancel modes remain available during internal staging and lock once
external landing authority is consumed. Persist interrupt/cancel requests and
terminal evidence. Resume remains fail-closed until worker interrupts are
terminal and every auxiliary session is terminal with its reservation released;
malformed or ambiguous ownership also blocks resume. Restart recovery must not
resurrect canceled work or delete preserved worktrees. A canceled or failed run
cannot advance integration or landing: runtime capacity is released, preserved
evidence remains inspectable, and destructive cancellation removes an
integration worktree/branch only after the persisted confirmation and exact
Fleet identity, repository, branch, head, and clean-worktree checks all match.

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

The implemented 40-worker status test asserts bounded/fair terminal captures,
and the 40-task scheduler wave test covers bounded launch fan-out. Resource and
query tests additionally bound DB/event/artifact work and run-detail polling.

## Merge strategy

Default strategy:

- One branch/worktree per implementation task.
- Keep exploration/review tasks read-only where possible.
- Use dependency order plus file-claim conflict ordering.
- Require verification and review before merge.
- Merge through a queue that re-validates after each integration.

Future strategies (not implemented by the current single-integration-result
runtime):

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

- A goal-only, no-initial-session epic automatically plans, receives four plan
  reviews, approves/starts, allocates providers, executes dependent tasks,
  verifies/reviews exact heads, stages in dependency order, consumes exact merge
  authority, and lands one green result.
- The sessionless lifecycle deliberately receives a blocking task review,
  launches one bounded automatic fixer, survives reconciler recreation, binds a
  new descendant head, re-verifies it, requires four fresh distinct clean review
  sessions, retains the historical blocker as audit evidence, and only then
  lands the fixed head.
- Reconciler launches ready tasks.
- Reconciler does not launch conflicting tasks.
- Reconciler recovers from spawn failure.
- Failed startup recovery keeps every launch-capable loop closed until one
  non-overlapping retry succeeds.
- Worker idle after running reads report artifact.
- Missing report blocks merge.
- `pause-new` preserves active paid owners; `pause-and-interrupt` durably stops
  exact-owned planner/reviewer/worker/fixer sessions and blocks resume until
  cleanup resolves.
- Cancel stops and settles all applicable Fleet-owned paid owners while exact
  preserve/destructive-cleanup semantics survive restart.
- Internal staging leaves controls open; exact external landing consumption
  locks approval/pause/cancel and rejects stale heads.

UI tests:

- Fleet Management run list.
- Run detail renders task lanes.
- Attention queue counts blocked tasks.
- Pause/resume/cancel actions.
- Exact concurrency, budget/hard-stop, skip, launch, read-only, and claim
  approval controls.
- Exact worker output and artifact lazy loading.
- Fleet Board run/task handoff and the mobile five-section switcher.
- Planner-only and imported-plan-review unattended-agent consent.
- Historical exact-head blockers remain in Artifacts but leave urgent attention
  after a clean descendant head; unresolved/malformed current evidence remains
  visible and fail-closed.

Regression tests:

- Pipeline behavior remains unchanged.
- Existing Fleet Board lane composition remains unchanged.
- Existing dispatch planner cap remains unchanged outside Fleet Management.
- New branch, base branch, and exact owned-existing-worktree session creation
  remain available without permitting a foreign project worktree.
- Kilo remains interactive/MCP-capable but is excluded from every unattended
  Fleet allocation, rejected at the final stale/manual spawn boundary, and
  terminalized before activation or polling when legacy rows are recovered.

## Implementation phases

### Phase state ledger

This ledger is the campaign resume surface. Update pre-merge fields on the
phase/slice branch before commit. Update post-merge fields only after the merge
truth exists; if that requires a bookkeeping PR, that PR is gated but does not
itself need another bookkeeping PR.

| Phase                                               | Status                            | Active branch/slice              | Pre-merge evidence                                                                                                                                                                                                                                                                                         | Post-merge reconciliation                                                                                                             | Current next action                        | Notes                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | --------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0: Plan and loop                              | Completed                         | Merged via PR #391               | Local gate green on branch head: `npx prettier --check .`, `npx tsc --noEmit`, `npm test` (306 files, 3539 tests), and `npm run build` pass with existing Turbopack warning; independent review gate clean after adversarial fixes; PR #391 final head `68efb34` had all CI checks green                   | Merged 2026-07-08 as `97aed5f`; final CI run `28982835413` green on `68efb34`; bookkeeping recorded by gated PR path                  | Phase 1 completed via PR #393              | Creates the durable plan, framework evaluation, visible execution contract, state ledger, and phase loop.                                                                                                                                                                                                                                                                                |
| Phase 1: Durable model and read-only UI             | Completed                         | Merged via PR #393               | Local gate green on branch head: `npx tsc --noEmit`, `npx prettier --check .`, `npm test` (310 files, 3558 tests), and `npm run build` pass with existing Turbopack warning; Chrome smoke test passed; final independent review clean; PR #393 final head `1643f51` had PR-head CI run `28985939366` green | Merged 2026-07-09 as `3c5cecd`; merged-state main push CI run `28986123466` green on `3c5cecd`; bookkeeping recorded by gated PR path | Phase 2 completed via PR #395              | Delivered durable draft-run model, read-only Fleet Management UI, approval preview, bounded draft payloads, no worker spawning, and client import tests.                                                                                                                                                                                                                                 |
| Phase 2: Plan ingestion and decomposition           | Completed                         | Merged via PR #395               | Local gate green on branch head: `npx tsc --noEmit`, `npx prettier --check .`, `npm test` (313 files, 3582 tests), and `npm run build` pass with existing Turbopack warning; browser smoke passed; final independent review clean; PR #395 final head `0efe58b` had PR-head CI run `29002393867` green     | Merged 2026-07-09 as `983d123`; merged-state main push CI run `29002655048` green on `983d123`; bookkeeping recorded by gated PR path | Phase 3/3A completed via PR #398           | Delivered durable plan ingestion, stable plan hashes, approval, critic artifacts, blocker gates, route body caps, and partial-schema repair.                                                                                                                                                                                                                                             |
| Phase 3: Scheduler and worker launch                | Completed                         | Merged via PR #398               | Historical branch gates and independent reviews were green.                                                                                                                                                                                                                                                | Merged on `main` as part of `fb3cf30`.                                                                                                | None                                       | Durable leases, idempotent/recoverable spawn, admission caps, conflict avoidance, lifecycle controls, and bounded 40-task scheduling are in `main`.                                                                                                                                                                                                                                      |
| Phase 3A: Automatic planner, allocation, MCP SDK v2 | Completed                         | Merged via PR #398               | Historical branch gates, MCP negotiation coverage, and independent reviews were green.                                                                                                                                                                                                                     | Merged on `main` as `fb3cf30`.                                                                                                        | None                                       | Dedicated planner sessions, automatic provider allocation, exact execution hashes, and the SDK v2/current+legacy transport boundary are in `main`; the current delivery branch further restricts Fleet allocation to verified unattended-capable providers.                                                                                                                              |
| Phase 4: Artifact contract and status aggregation   | Implemented; release gate pending | `feat/fleet-autonomous-delivery` | Focused report/Git-state/status/output/artifact suites green; repository-wide final gate still pending.                                                                                                                                                                                                    | Pending PR CI and merge.                                                                                                              | Complete final integrated gate and review. | Nonce/attempt JSON reports, bounded collection, Git-derived exact heads/claims/sensitive paths, fair 40-worker capture, lazy exact output/artifact reads, missing-report quarantine, recovery, and Fleet Board handoff are implemented.                                                                                                                                                  |
| Phase 5: Verify and review gates                    | Implemented; release gate pending | `feat/fleet-autonomous-delivery` | Focused direct-argv verification and exact-head four-lane review/fix/control suites green, including restart between fixer launch and result collection; repository-wide final gate still pending.                                                                                                         | Pending PR CI and merge.                                                                                                              | Complete final integrated gate and review. | Clean-worktree verification, four independent lanes, immutable findings, bounded descendant-head fixes, stale-evidence invalidation, and exact budget/concurrency/task/claim controls are implemented.                                                                                                                                                                                   |
| Phase 6: Merge integration                          | Implemented; release gate pending | `feat/fleet-autonomous-delivery` | Focused merge/readiness/control, multi-task sessionless E2E, and blocker-to-fixed-head-to-merge E2E suites green; repository-wide final gate still pending.                                                                                                                                                | Pending PR CI and merge.                                                                                                              | Complete final integrated gate and review. | Dependency-ordered internal staging and final verification remain controllable until an exact transaction consumes external landing authority; local fast-forward and GitHub no-force PR/check/head/merge flows then fail closed on drift.                                                                                                                                               |
| Phase 7: Lifecycle hardening                        | Implemented; release gate pending | `feat/fleet-autonomous-delivery` | Focused startup/lifecycle/cost/retry/source/analytics/executor/migration suites green; repository-wide final gate still pending.                                                                                                                                                                           | Pending PR CI and merge.                                                                                                              | Complete final integrated gate and review. | Fail-closed startup retry, three-attempt transient auxiliary retry, installed-only source allocation/default-branch resolution, all-owner cost/pause/cancel, quota-safe cleanup, archival/retention/analytics, and a remote-executor seam are implemented. Strong confinement still requires future per-attempt Git/provider isolation, so unattended launches require explicit consent. |
| Phase 8: AI supervisor and scoped MCP control       | Implemented; release gate pending | `feat/fleet-autonomous-delivery` | Focused capability/MCP/supervisor suites green; repository-wide final gate still pending.                                                                                                                                                                                                                  | Pending PR CI and merge.                                                                                                              | Complete final integrated gate and review. | Hash-bound advisory supervisor snapshots/recommendations and scoped direct MCP read/lifecycle tools are implemented without making either authoritative.                                                                                                                                                                                                                                 |

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
- Adapter links to existing sessions, explicit Dispatch/Pipeline/Builder source
  imports, Fleet Board navigation, verification, and merge primitives. Verdict
  Inbox remains an existing dispatch/ceremony surface rather than a Fleet run
  datastore.
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

- Fleet-owned `$STOA_HOME/fleet/<run>/<task>/<attempt>/report.json`,
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

Status: implemented. The prompt carries a nonce/attempt report contract; the
collector binds it to exact Git base/head/timestamps, derives changed files and
sensitive paths independently, bounds reads/polls/artifacts, and quarantines
invalid or missing evidence. Restart reconciliation resumes collection without
inventing success.

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

Status: implemented. Verification is shell-free/direct-argv and bound to an
unchanged clean head. Four distinct reviewer sessions/lenses must submit current
head evidence. Policy-authorized fix rounds preserve old blockers, require a new
descendant commit, invalidate stale evidence, and repeat verification/review.

### Phase 6: Merge integration

Deliver:

- Fleet-owned durable integration reusing Dispatch's exact PR merge/SHA
  invariants.
- Dependency-order landing.
- Conflict detection.
- Re-verify after integration.
- PR/branch handoff where configured.

Definition of done:

- A multi-task run lands green disjoint changes in order.
- Conflict tasks stop and request operator input.
- Verified/reviewed SHA pinning prevents stale merges.

Status: implemented. Fleet owns a durable integration lease/worktree and applies
tasks in dependency order, with per-task and final verification. Internal
staging does not freeze approval controls or consume external merge authority.
One atomic transaction revalidates the active run, desired state, approved
execution, graph, claims, policy, pinned base, final verification, and exact
integration head before it records the landing request and consumes its one-shot
authorization. Local landing requires an exact clean fast-forward. GitHub
landing never force-pushes and rechecks required CI, an explicit pass-conclusion
allowlist, PR head identity, and the pinned base SHA immediately before merge.
Base drift stops for a fresh approval cycle; already-reviewed work is never
silently rebased. Canceled/failed runs cannot continue integration, and exact
terminal cleanup releases runtime capacity without deleting preserved evidence.

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

Status: implemented. Provider and auxiliary launches retry only
transient/rate-limit failures after exact ownership-safe cleanup, stopping after
three failures; restart-safe deterministic exponential backoff starts at 5
seconds and caps at 5 minutes. Registry-deterministic installed unattended-provider
fallback clears foreign models before retry. Archive/retention preserve audit metadata while pruning
bounded artifact bodies; lifecycle safety events remain writable at data-plane
quota exhaustion; cleanup previews bind a complete canonical target digest and
delete only those exact Fleet-owned worktrees with compare-and-set recovery;
phase-independent cost enforcement interrupts
primary and auxiliary sessions durably; analytics summarize outcomes and budget
estimates; and the executor interface can host a future remote/cloud
implementation without adding a second scheduler.

### Phase 8: AI supervisor layer

Deliver:

- Optional conductor/supervisor task that reads durable summaries.
- Supervisor recommendations for re-planning, retries, grouping, and merge
  ordering.
- MCP tools for fleet run control.

Definition of done:

- Supervisor can help manage the run, but killing/closing it does not lose run
  truth.

Status: implemented. The deterministic supervisor snapshot is bound to current
plan/execution/policy/base/task-head evidence. Built-in recommendations are pure
advice, and optional AI/conductor recommendations are append-only artifacts and
events. Neither path executes actions or grants approval. Scoped MCP control is
implemented separately from supervisor authority.

## Migration from existing systems

Pipeline:

- Keep current pipeline API stable.
- PipelineSpec payloads can be explicitly imported into Fleet Management.
- Do not make existing in-memory pipeline behavior durable in the same PR as
  Fleet Management v1 unless it is necessary.

Dispatch:

- Reuse claim parsing and task decomposition ideas.
- Do not change existing dispatch rows into fleet tasks automatically.
- Dispatch planner/issue payloads can be explicitly promoted through the Fleet
  import route/source adapter; no implicit conversion occurs.

Fleet Board:

- Keep it as cross-run lifecycle overview.
- Link Fleet Board cards to fleet runs/tasks when applicable.
- Add Fleet Management as a focused run execution view.

MCP:

- Keep current orchestration tools.
- Retain informational `fleet_request_action`.
- Direct Fleet reads and lifecycle tools now require server-issued scoped
  capabilities. Reads are reusable and run-scoped; mutations are one-use and
  action/identity/hash-bound. Capability issue/revoke remains admin-only, and
  scheduler tick, worker kill, and cleanup remain outside MCP.

## Answer to the 40-agent question

Can Claude or Codex MCP conductor pattern manage 40 agents working on a plan?

It can help coordinate them, but it is not the source of truth. Stoa accepts a
goal/high-level specification, creates a bounded isolated planner when needed,
persists and displays the task DAG and installed unattended-provider allocation, gates the
exact plan, and launches approved work in admission-controlled waves. With the
explicit automatic-approval and automatic-start policy enabled, this happens
without a user-created initial session. The scheduler, leases, recovery state,
and Fleet UI survive every agent/conductor context and process lifetime.

The reliable design is:

- Server-side fleet scheduler for truth and lifecycle.
- Agents as workers/reviewers/planners.
- Conductor as optional supervisor over summaries.
- Operator UI for approval and intervention.
- Git worktrees/branches/PRs for audit and merge safety.

The implemented delivery loop now includes Fleet-owned completion evidence,
server-run exact-head verification, four independent runtime review lanes,
bounded fix rounds, dependency-ordered integration, final verification, and
SHA-pinned local or GitHub landing. The hard planner ceiling is 40 tasks; actual
parallel execution remains admission-controlled by the configured run/provider/
host limits and budget.

## Resolved design questions

- Workers remain local by default. A framework-neutral executor seam supports a
  future cloud/offloaded adapter without changing Fleet's authority model.
- Merge integration supports both exact local fast-forward and GitHub PR/CI.
- Parallelism is explicitly configured per run (maximum 40) and further bounded
  by host/provider admission; Windows continues to use the normal Tier 2
  pty-host policy rather than a separate Fleet-only magic number.
- Every implementation/fix task owns an isolated worktree. Exploration/review
  work is read-only; shared writable worktrees remain outside Fleet v1.

## Historical first PR checklist (completed)

This checklist describes the completed durable-spine slice; the phase ledger is
the current status source.

- Add `lib/fleet/types.ts`.
- Add pure `lib/fleet/engine.ts`.
- Add migration/schema for `fleet_runs`, `fleet_tasks`,
  `fleet_task_dependencies`, `fleet_task_claims`, `fleet_workers`,
  `fleet_artifacts`, and `fleet_events`.
- Include lease, scheduler epoch, approval hash/state, budget reservation,
  recovery, spawn correlation, attempt, cleanup, and session FK fields.
- Add typed queries under `lib/db/queries/fleet.ts`.
- Add adapter fields/queries linking fleet runs/tasks to existing sessions and
  explicit source lineage; Fleet Board links into Fleet Management while
  Verdict Inbox keeps its existing dispatch/ceremony scope.
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
