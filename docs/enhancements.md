# Stoa Enhancements Plan

> Living implementation plan for making Stoa the most complete self-hosted
> cockpit for AI coding agents. Replaces all previous roadmaps and upgrade docs.
> Updated: 2026-08-08.

## Executive Summary

Stoa is already a capable, mobile-first, cross-platform cockpit for running AI
agents in real terminals. To grow its star count and user base we will close the
gaps with the closest competitors (Agent of Empires, TermHive, agent-dashboard,
Agent Cockpit, OctoAlly, Agency, cctop, fleet) while doubling down on the
features nobody else has: native Windows pty support, autonomous GitHub dispatch,
Fleet orchestration, and a mobile-first PWA.

This plan contains **30 ranked features**, grouped into **5 delivery phases**.
Each feature includes user value, technical seams, effort, and acceptance
criteria. The plan is execution-oriented: every item either extends an existing
Stoa subsystem or opens a small, well-defined new seam.

## Competitive Baseline

Closest competitors and the capabilities Stoa must match or exceed:

| Project                    | Why it matters for Stoa                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Agent of Empires (AoE)     | TUI + web dashboard, multi-backend, worktrees, Docker sandbox, live status, mobile/PWA, persistent sessions |
| TermHive                   | Web multi-agent dashboard, xterm.js, grid/canvas layouts, project wiki, shared content, MCP agent messaging |
| agent-dashboard (bjornjee) | tmux dashboard + PWA, live pane capture, status grouping, GitHub PR workflow, token/cost view               |
| Agent Cockpit              | Browser control room, live terminals, approval queues, session replay, local-first                          |
| OctoAlly                   | Multi-agent hive-mind, live grid, persistence, desktop app, voice                                           |
| Agency                     | Markdown/YAML based, inbox/approve pipeline, CLI + web                                                      |
| cctop                      | htop for Claude Code — live status, context %, tokens, costs                                                |
| fleet                      | TUI cockpit for parallel sessions with worktrees and status via hooks                                       |

Stoa's existing moats: native Windows pty (no tmux/WSL), Fleet autonomous
dispatch, multi-repo worktree sessions, shared memory/notes, Best-of-N, spend
tracking, offline queue, cross-platform backend abstraction.

## Strategy

1. **Differentiate where we already lead** — Fleet, Windows-native pty, mobile
   PWA, dispatch, multi-repo worktrees.
2. **Close parity gaps** — session replay, approval queues, PWA polish, project
   wiki, cost dashboard, team sharing.
3. **Add a small number of "wow" features** — voice control, desktop app,
   Docker sandbox, plugin marketplace, public REST API.
4. **Keep every change cross-platform, tested, and gated by 3-agent review.**

## Top 30 Features (Ranked)

### Phase 1: Operator Experience (foundation, highest impact/effort ratio)

| #   | Feature                                | User Value                                                                                            | Existing Seam                                                       | Effort | Status          |
| --- | -------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------ | --------------- |
| 1   | **Session Replay & Timeline Scrubber** | Re-watch any agent run, jump to errors, share links to specific moments.                              | Snapshots API (`/api/sessions/[id]/snapshots`) + `SnapshotTimeline` | M      | Planned         |
| 2   | **Human-in-the-Loop Approval Queue**   | Central queue for permission prompts, guardrail blocks, and dispatch approvals.                       | Guardrails + Fleet approvals + Ask Stoa                             | M      | Planned         |
| 3   | **PWA Install & Offline-First Shell**  | Install Stoa to phone/desktop home screen; offline queue already exists, make the shell work offline. | serwist service worker + offline queue                              | S      | Planned         |
| 4   | **Session Templates / Quick Starts**   | One-click templates for common tasks (bug fix, refactor, write tests).                                | Playbooks + NewSessionDialog                                        | S      | Planned         |
| 5   | **Real-Time Cost Dashboard**           | Fleet-wide spend, per-project/model, budget alerts.                                                   | `lib/session-cost.ts`, `CostIndicator`, Fleet analytics             | M      | **DONE (#416)** |

### Phase 2: Team & Collaboration

| #   | Feature                           | User Value                                                             | Existing Seam                | Effort | Status              |
| --- | --------------------------------- | ---------------------------------------------------------------------- | ---------------------------- | ------ | ------------------- |
| 6   | **Multi-User Workspace**          | Multiple users share the same Stoa instance with isolated projects.    | Projects + auth tokens table | L      | **DONE (#418)**     |
| 7   | **Project Wiki / Knowledge Base** | Long-lived project docs, automatically linked by agents.               | Notes dialog + shared memory | M      | **DONE (#417)**     |
| 8   | **Session Sharing & Deep Links**  | Share a read-only session view or a specific replay timestamp.         | Session status + snapshots   | S      | **DONE (#417)**     |
| 9   | **Audit Log & Compliance Export** | CSV/JSON export of all agent actions, approvals, and guardrail events. | Events ledger + guardrails   | M      | **Already shipped** |
| 10  | **Comment / Annotation Layer**    | Add human comments on a session replay or snapshot for hand-off.       | Snapshots + session events   | S      | **DONE (#417)**     |

### Phase 3: Control & Trust

| #   | Feature                         | User Value                                                                  | Existing Seam                      | Effort | Status                        |
| --- | ------------------------------- | --------------------------------------------------------------------------- | ---------------------------------- | ------ | ----------------------------- |
| 11  | **Approval Queue Mobile Push**  | Get notified on phone when an agent needs approval.                         | Web push + approval queue          | S      | Planned                       |
| 12  | **Docker Sandbox Per Agent**    | Run each agent in a clean container with repo mounted.                      | PtyTransport + container-transport | L      | Deferred (XL)                 |
| 13  | **Guardrails Policy Editor UI** | Visual rule editor for BLOCK/WARN patterns, no JSON editing.                | Guardrails rules + `Rule` type     | M      | **DONE (#418)**               |
| 14  | **Secret Scan Pre-Flight**      | Scan every staged change for secrets before agent commits.                  | `secret-scan` API                  | S      | **Already shipped**           |
| 15  | **RBAC & Permissions**          | Roles (admin, operator, viewer) controlling who can prompt, approve, merge. | Auth tokens + multi-user           | L      | **Foundation shipped (#418)** |

### Phase 4: Scale & Intelligence

| #   | Feature                             | User Value                                                             | Existing Seam                       | Effort | Status                               |
| --- | ----------------------------------- | ---------------------------------------------------------------------- | ----------------------------------- | ------ | ------------------------------------ |
| 16  | **Agent Marketplace / Skill Store** | Discover and install community playbooks, MCP servers, slash commands. | Playbooks + skills API + MCP config | L      | Planned                              |
| 17  | **Multi-Model Routing & Fallbacks** | Auto-switch model on rate-limit or cost; route by task type.           | Model catalog + providers           | M      | **Partial (model-router exists)**    |
| 18  | **Auto-Fix Loop**                   | Detect test/build failure, spawn repair agent, verify, merge.          | Fleet + dispatch + CI fix           | L      | **Partial (dispatch CI fix exists)** |
| 19  | **Code Review Agent**               | Dedicated agent that reviews a PR and posts findings.                  | Dispatch + review planner           | M      | **Partial (review planner exists)**  |
| 20  | **Documentation Agent**             | Keeps README/API docs in sync with code changes.                       | Ask Stoa + git commit               | M      | Planned                              |
| 21  | **Test Generation Agent**           | Generate missing tests for a file or branch.                           | New session + prompt templates      | M      | Planned                              |
| 22  | **Refactor Agent**                  | Safe, scoped refactoring with plan/approve/apply flow.                 | Best-of-N + diff view               | M      | Planned                              |
| 23  | **Smart Cost Alerts**               | Slack/Discord/email when budget threshold breached.                    | Cost dashboard + web push           | S      | **DONE (this phase)**                |

### Phase 5: Platform & Distribution

| #   | Feature                         | User Value                                                   | Existing Seam                    | Effort | Status  |
| --- | ------------------------------- | ------------------------------------------------------------ | -------------------------------- | ------ | ------- |
| 24  | **Public REST API**             | External tools can query sessions, costs, and dispatch runs. | API routes + tokens              | M      | Planned |
| 25  | **Plugin / Extension API**      | Third-party extensions add UI panels and backend jobs.       | Components + API hooks           | L      | Planned |
| 26  | **Desktop App Wrapper**         | Native Electron/Tauri wrapper around the web UI.             | Next.js + server.ts              | L      | Planned |
| 27  | **Voice Control**               | Push-to-talk voice prompt input and spoken status updates.   | Web Speech API + mobile          | M      | Planned |
| 28  | **One-Click Cloud Deploy**      | Deploy Stoa to Render/Railway/Fly with a single button.      | Docker + install scripts         | M      | Planned |
| 29  | **CI/CD Webhooks**              | GitHub Actions/GitLab triggers dispatch from CI events.      | Webhooks intake + dispatch       | S      | Planned |
| 30  | **Interactive Onboarding Tour** | First-run guide that creates a sample session.               | StoaGuide + onboarding checklist | S      | Planned |

## Phase 1: Detailed Implementation Plan

Phase 1 ships the five highest-impact, lowest-risk features. Each feature lists
files to touch, tests to add, and the gate criteria.

### 1.1 Session Replay & Timeline Scrubber

**What it does:** Turns the existing snapshot system into a playable timeline.
Any session can be opened in a read-only "Replay" view where the user scrubs
through snapshots, sees the rendered terminal at each point, and jumps to
errors/guardrails/events.

**Files to touch:**

- `app/api/sessions/[id]/snapshots/route.ts` — add metadata (timestamp, event markers).
- `components/SnapshotTimeline/` — scrubber UI, extend existing component.
- `components/views/ReplayView/` — new read-only view with rendered terminal.
- `lib/session-status.ts` — expose event markers (error, guardrail, exit, prompt).
- `components/views/view-meta.tsx` — register the new view.

**Tests:**

- Snapshots returned in chronological order with markers.
- Scrubber computes correct snapshot index from timestamp.
- Replay view is read-only (no send/queue buttons).
- Mobile layout renders without overflow.

**Acceptance:**

- Open any session, click "Replay" → see a timeline below the terminal.
- Scrubbing updates the rendered terminal within 200ms.
- Markers show errors, guardrail blocks, and user prompts.

### 1.2 Human-in-the-Loop Approval Queue

**What it does:** Aggregates all places an agent waits for a human into a single
queue: Claude/Codex permission prompts, guardrail BLOCK violations, and Fleet
dispatch approvals. The queue is accessible from the header and from the mobile
view.

**Files to touch:**

- `lib/approvals.ts` — new aggregation module (guardrail blocks + pending prompts + fleet approvals).
- `app/api/approvals/route.ts` — list/count/approve/reject.
- `components/ApprovalQueue/` — queue panel and badge in header.
- `lib/guardrails.ts` — emit BLOCK events into approval queue.
- `lib/fleet/operator-actions.ts` — emit dispatch approvals.

**Tests:**

- BLOCK guardrail appears in queue with actionable context.
- Approving a guardrail resumes the session.
- Approving a fleet dispatch updates the run state.
- Badge count reflects pending items across all sources.

**Acceptance:**

- A guardrail BLOCK adds one item to the queue.
- Mobile user opens queue, reads context, taps approve/reject.
- Rejecting ends the offending session safely.

### 1.3 PWA Install & Offline-First Shell

**What it does:** Make Stoa installable as a PWA and ensure the static shell
loads offline. The existing offline queue handles prompt replay; this feature
adds an offline home page, cached session list, and install prompt.

**Files to touch:**

- `public/manifest.json` — ensure icons, theme, display mode are correct.
- `app/layout.tsx` or PWA metadata — add `beforeinstallprompt` handler.
- `components/OfflineShell/` — offline placeholder when API unreachable.
- `lib/offline-queue.ts` — extend to queue lightweight reads (session list).
- serwist service worker config — precache shell and static routes.

**Tests:**

- Manifest passes Lighthouse PWA audit.
- Service worker precaches the shell.
- Offline queue replays prompts after reconnect.
- Session list is cached and shown stale while offline.

**Acceptance:**

- Chrome/Edge/Safari offer "Install Stoa".
- Phone installed app opens and shows cached session list without network.
- Prompt sent offline is replayed and acknowledged when online.

### 1.4 Session Templates / Quick Starts

**What it does:** Turns playbooks into user-editable session templates that
appear in the New Session dialog. Example templates: "Fix a bug", "Write tests",
"Refactor file", "Review PR". Each template pre-fills prompt, agent, model,
and worktree settings.

**Files to touch:**

- `lib/playbooks.ts` — add schema/versioning, allow user templates.
- `app/api/playbooks/route.ts` — CRUD for templates.
- `components/NewSessionDialog/PlaybookSelector.tsx` — show templates grouped by category.
- `components/PlaybookManager/` — create/edit/delete templates.
- `data/` — default templates shipped with the app.

**Tests:**

- Default templates load on first run.
- Selecting a template pre-fills the form.
- Custom templates persist in SQLite.
- Invalid templates are rejected by schema.

**Acceptance:**

- New Session dialog shows "Quick Start" templates.
- Selecting "Fix a bug" fills a prompt like "Find and fix the bug described in the tests...".
- User can create, edit, and delete their own templates.

### 1.5 Real-Time Cost Dashboard

**What it does:** A dedicated view showing live and historical spend across
sessions, projects, providers, and models. Includes budget alerts and per-agent
breakdown. Extends the existing `CostIndicator` and Fleet analytics.

**Files to touch:**

- `lib/session-cost.ts` — aggregate APIs (by project, by day, by model).
- `app/api/sessions/cost/` — add aggregation routes.
- `components/views/CostDashboardView/` — new view with charts/tables.
- `components/views/view-meta.tsx` — register view.
- `lib/budget.ts` — threshold alerts (new module, small).

**Tests:**

- Aggregations sum correctly across sessions and days.
- Budget alert fires when threshold is exceeded.
- Dashboard handles zero-cost state gracefully.
- Mobile table collapses to cards.

**Acceptance:**

- Cost view shows total today, this week, this month.
- Per-project and per-model breakdowns are available.
- Approaching a budget cap shows a warning badge.

## 3-Agent Review Gate per Phase

For every phase:

1. **Correctness / Security** — review for bugs, injection risks, secret leaks,
   cross-platform regressions.
2. **Conventions / UX** — follow Stoa patterns, mobile-first, consistent UI,
   keep docs in sync.
3. **Adversarial / Red Team** — attempt to break the feature: malformed inputs,
   race conditions, unbounded growth, permission bypasses, offline edge cases.

Only merge when all three lenses are clean. CI matrix (ubuntu + macos + windows)
plus prettier must be green.

## Success Metrics

After all 5 phases:

- README mentions all shipped features and links to in-app Guide.
- Test coverage stays ≥ 80% for new pure logic.
- No new POSIX-only or Windows-only code without cross-platform abstraction.
- GitHub stars and install script usage tracked as adoption proxy.
- Issue backlog for new features is smaller than backlog for bugs.

## Open Questions

- **Desktop wrapper:** Tauri vs Electron. Tauri is smaller; Electron is more
  familiar. Decision deferred to Phase 5 spike.
- **Multi-user auth:** Stoa is currently single-user. Phase 6 (beyond this plan)
  may add full auth. Phase 2 "workspace" is token-scoped, not login-scoped.
- **Plugin API:** Browser extensions vs server plugins. Spike before Phase 5.
