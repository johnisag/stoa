# Stoa Upgrades Roadmap

> Researched 2026-08-07. Sourced from GitHub + web analysis of 50+ multi-star
> projects in the AI agent orchestration, terminal multiplexer, and agent
> monitoring space.

## Competitive Landscape

### Tier 1 — Direct competitors (similar scope)
| Project | Stars | Stack | Key differentiator |
|---------|-------|-------|-------------------|
| **herdr** (herdrdev/herdr) | 25.5k | Rust | Terminal runtime, 21-agent detection, plugin marketplace |
| **amux** (andyrewlee/amux) | 145 | Go | Worktree-first TUI, workspace model, Claude-focused |
| **agent-flow** (patoles/agent-flow) | 1.5k | TS/React | Real-time agent visualizer (think → branch → coordinate graph) |
| **sculptor** (imbue-ai/sculptor) | 213 | — | Grounded parallel agents |
| **cezar** (open-mercato/cezar) | 124 | — | Multi-agent per-step (Claude/Codex/OpenCode mix), fire-and-forget PR |
| **harness** (majiayu000/harness) | 56 | Rust | Fleet with governance: policy, cross-agent review, observability |
| **graphone** (PriNova/graphone) | 87 | Tauri/Svelte | Visual workbench for local + remote LLMs |

### Tier 2 — Adjacent (monitoring, cost, compliance)
| Project | Stars | Focus |
|---------|-------|-------|
| **claude-code-tamagotchi** | 432 | Real-time behavioral enforcement, violation detection |
| **claude-code-monitoring-guide** | 360 | Anthropic's official monitoring guidance |
| **claude-code-monitor** (onikan27) | 271 | Mobile web dashboard for Claude sessions |
| **ClaudeCodeMonitor** (Aura) | 44 | macOS menu bar real-time monitor |
| **ccost** / **receipt** | emerging | Post-session cost tracking, per-PR token reporting |

### What Stoa has that nobody else has
- Mobile-first responsive web UI (phone access from anywhere)
- Fleet orchestration (epic-to-merge autonomous)
- Analytics + audit + verdict inbox
- Dispatch pipeline (issue triage, workflow generation)
- Best-of-N comparison view
- Cross-platform (Windows/macOS/Linux) with native pty support
- 7 providers (Claude, Codex, Hermes, Kilo, Kimi, Prime, shell)


## UPGRADES — Phased Implementation Plan

### PHASE 1: Cost & Token Tracking (NEW)
> Inspired by: ccost, receipt, l6e-mcp. Nobody in the terminal-mux space
> has per-session, per-agent, per-model cost tracking. Stoa already has
> session-cost infrastructure (lib/session-cost.ts).

**U1. Real-time cost dashboard**
- Surface token usage + estimated cost per session in real-time
- Aggregate by project, provider, model, day
- Show cache hit/miss ratio (Claude prompt caching)
- Alert when approaching API budget limits
- Files: extend lib/session-cost.ts, new components/views/CostDashboardView

**U2. Per-PR cost comment**
- After a Fleet worker merges, post a cost summary comment on the PR
- Token breakdown by model, cache savings, total $ spent
- Files: extend lib/fleet/ merge flow

### PHASE 2: Agent Activity Graph (NEW)
> Inspired by: agent-flow (1.5k stars). Real-time visualization of agent
> decision trees, tool call chains, and subagent coordination. Their key
> insight: "Claude Code is a black box — you see the result, not the journey."

**U3. Agent activity timeline**
- Parse Claude/Codex transcript JSONL into a timeline of decisions + tool calls
- Show think → tool-call → result → branch as an interactive graph
- Identify slow tool calls, unnecessary branching, redundant work
- Files: new lib/activity-graph.ts, components/views/ActivityGraphView

**U4. Subagent coordination view**
- Visualize parent→child agent spawns as a tree
- Show which subagent is blocked, working, or done
- Files: extend Fleet view with a coordination overlay

### PHASE 3: Behavioral Guardrails (NEW)
> Inspired by: claude-code-tamagotchi (432 stars). Real-time enforcement
> of safety rules. Detects violations and interrupts misbehavior.

**U5. Rule-based action monitor**
- Define rules (no rm -rf, no force push, no deploys without approval)
- Monitor agent screen output for violations in real-time
- Alert + optionally auto-interrupt the session
- Files: new lib/guardrails.ts, components/views/GuardrailsView

**U6. Auto-interrupt on dangerous patterns**
- When a dangerous command appears on screen, auto-send Ctrl+C
- Configurable allowlist/denylist per project
- Files: extend session status tick with guardrail checks

### PHASE 4: Smart Session Grouping (ENHANCEMENT)
> Inspired by: amux's workspace-first model, beacon-fleet's Kanban board

**U7. Kanban-style session board**
- Drag sessions between columns (backlog → in-progress → review → done)
- Visual workflow status at a glance
- Files: new components/views/KanbanBoardView

**U8. Smart session auto-labeling**
- Auto-generate session names from the first prompt or git branch
- Group sessions by task/epic automatically
- Files: extend session creation flow

### PHASE 5: MCP Server Marketplace (NEW)
> Inspired by: herdr's plugin marketplace, the MCP ecosystem

**U9. In-app MCP server browser**
- Browse and install MCP servers from the registry
- Configure per-project MCP servers from the UI
- Files: new components/views/MCPMarketplaceView, extend lib/mcp/

**U10. MCP server health monitoring**
- Show which MCP servers are connected, responsive, erroring
- Auto-reconnect failed MCP servers
- Files: extend lib/mcp-config.ts

### PHASE 6: Performance & Polish (ENHANCEMENT)
> Inspired by: amux's PERF_BASELINES.md, herdr's render optimizations

**U11. Session list virtualization**
- Virtualize the session list for 100+ sessions (currently renders all DOM nodes)
- Files: refactor SessionList with react-window or similar

**U12. Terminal render optimization**
- Debounce xterm.js renders during high-output bursts
- Files: extend Terminal component

**U13. WebSocket connection pooling**
- Share a single WS connection for status events across all views
- Files: extend data/statuses/useStatusEventStream.ts


## Priority Matrix

| ID | Feature | Impact | Effort | Priority |
|----|---------|--------|--------|----------|
| U1 | Cost dashboard | HIGH | MED | **P0** |
| U5 | Guardrails | HIGH | MED | **P0** |
| U3 | Activity graph | HIGH | HIGH | **P1** |
| U7 | Kanban board | MED | MED | **P1** |
| U11 | List virtualization | MED | LOW | **P1** |
| U2 | Per-PR cost | MED | LOW | **P2** |
| U6 | Auto-interrupt | MED | LOW | **P2** |
| U9 | MCP marketplace | MED | HIGH | **P2** |
| U4 | Subagent view | LOW | HIGH | **P3** |
| U8 | Auto-labeling | LOW | LOW | **P3** |
| U10 | MCP health | LOW | MED | **P3** |
| U12 | Render optimization | LOW | LOW | **P3** |
| U13 | WS pooling | LOW | MED | **P3** |


## Execution Order

Phase 1 (P0): U1 → U5
Phase 2 (P1): U3 → U7 → U11
Phase 3 (P2): U2 → U6 → U9
Phase 4 (P3): remaining items

3-agent review gate at the end of each phase.
