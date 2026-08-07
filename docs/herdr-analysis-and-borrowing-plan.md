# Herdr Deep Analysis & Borrowing Plan

> Analysis date: 2026-08-07
> Herdr version analyzed: v0.8.0 (master, commit 79a953e)
> Repo: https://github.com/herdrdev/herdr — 25.5k stars, 1.8k forks, Apache-2.0

## TL;DR

Herdr and Stoa are solving the **same problem** (running AI coding agents in
persistent terminals) from **opposite directions** with **different core
bet**: Herdr is a Rust terminal multiplexer (the tmux replacement); Stoa is
a mobile-first web UI (the browser-based cockpit). They are not
competitors — they are complementary layers that could even run together.

**Should we abandon Stoa for Herdr? No.** Stoa's web UI, Fleet orchestration,
analytics, dispatch pipeline, and audit/verification system are capabilities
Herdr doesn't have and doesn't want. Herdr's strengths are in terminal
performance, pane-level agent state detection, and the agent-to-agent socket
API — areas where Stoa is weaker.

**What we should borrow:** Five high-value architectural patterns and features
that would make Stoa materially better, ranked by impact and effort below.


## 1. What Herdr Actually Is

### Core identity
Herdr is a **terminal workspace runtime** written in Rust. Think "tmux, but
designed from the ground up for AI coding agents." Key properties:

- **Background server architecture**: A persistent server process owns real
  PTYs. Clients (TUI, CLI, API) attach to it. Close the terminal, drop the
  network, restart the machine — agents keep running. Reattach from any
  terminal or over SSH.
- **One Rust binary, no Electron**: Runs in whatever terminal you already use.
  ~211K lines of Rust across 235 source files.
- **Agent-native**: The CLI and socket API are the same surface agents use to
  drive each other — spawn panes, prompt each other, wait until another agent
  is genuinely blocked.
- **Apache-2.0 licensed** (relicensed from AGPL in v0.8.0).

### Scale and maturity
- 1,348 commits, 72 branches, 79 tags, 3,002 test functions
- Active development: commits within hours of analysis
- Y Combinator backed
- Supports 21 coding agents (Claude, Codex, Gemini, Cursor, Devin, Cline,
  Pi, OMP, OpenCode, Copilot, Kimi, Kiro, Droid, Amp, Grok, Hermes, Kilo,
  Qodercli, Maki, Antigravity, Mastracode)
- 19 agent detection manifest files (TOML-based pattern matching)
- Plugin marketplace with Cloudflare Worker backend


## 2. Architectural Comparison

### Where Herdr wins

| Dimension | Herdr | Stoa |
|-----------|-------|------|
| **Core runtime** | Rust server binary, owns PTYs directly | Node.js server, delegates to tmux/pty backends |
| **Persistence model** | Server owns terminals; detach/reattach is native | Web server manages sessions; browser must reconnect |
| **Agent state detection** | TOML manifest system, 21 agents, screen + OSC + process detection, hot-reloadable | Hardcoded status-detector, 6 providers, screen-only |
| **Agent-to-agent API** | Full socket API: agents spawn/prompt/wait/read each other | No agent-to-agent coordination surface |
| **Remote access** | Native SSH thin-client (`herdr --remote <host>`) | Web-based (needs server running + port forwarding) |
| **Plugin system** | TOML manifest-driven, marketplace, event hooks, pane injection | None |
| **Terminal fidelity** | Vendored libghostty-vt (Ghostty's VT emulator) | xterm.js in browser |
| **Performance** | Native Rust, ~95% less CPU than 10 separate terminals | Node.js + WebSocket overhead |
| **Worktree management** | First-class: create/link/discover git worktrees as workspaces | API route exists but not first-class in UI |

### Where Stoa wins

| Dimension | Stoa | Herdr |
|-----------|------|-------|
| **UI paradigm** | Mobile-first responsive web UI (phone, tablet, desktop) | TUI (ratatui) — requires a real terminal |
| **Fleet orchestration** | Full epic-to-merge autonomous orchestration, worker allocation, approval gates | No fleet concept |
| **Analytics & audit** | Analytics dashboard, audit findings, verdict inbox, compliance | None |
| **Dispatch pipeline** | Issue triage, command proposal, workflow generation, pipeline DAG | None |
| **Best-of-N comparison** | Parallel agent comparison view | None |
| **Cross-platform reach** | Any device with a browser (including phone from the couch) | Terminal only (no phone access) |
| **Multi-user potential** | Web server can serve multiple users | Single-user, single-machine |
| **Visual design** | Rich component system, Lucide icons, card layouts, animated transitions | TUI aesthetics (good for a TUI, but still a TUI) |


## 3. The Five Things to Borrow (Ranked)

### BORROW #1: TOML Agent Detection Manifests (HIGH impact, MEDIUM effort)

**What Herdr does:** Each agent has a TOML manifest file
(`src/detect/manifests/<agent>.toml`) that declares pattern-matching rules for
detecting agent state. Example from `claude.toml`:

```toml
id = "claude"
version = "2026.08.04.1"

[[rules]]
id = "osc_title_working"
state = "working"
priority = 1100
region = "osc_title"
visible_working = true
regex = ['^[\x{2800}-\x{28FF}] ']

[[rules]]
id = "live_blocked_form"
state = "blocked"
priority = 980
region = "after_last_horizontal_rule"
visible_blocker = true
contains = ["esc to cancel"]
any = [
  { contains = ["enter to confirm"] },
  { contains = ["enter to select"], any = [...] },
]
```

Rules have: `id`, `state` (working/blocked/idle/unknown), `priority`,
`region` (which part of the screen to scan), `contains`/`any`/`regex`
matchers, and visual-signal flags (`visible_working`, `visible_blocker`,
`visible_idle`). The detector reads the bottom-buffer and evaluates rules
in priority order.

**Why this is better than Stoa's approach:** Stoa's `status-detector.ts`
hardcodes regexes in TypeScript. Adding a new agent or fixing a detection
bug requires a code change, test, build, deploy. Herdr's manifests are
data files that can be hot-reloaded without restarting the server
(`herdr server reload-agent-manifests`), and users can add local overrides
at `~/.config/herdr/agent-detection/<agent>.toml`.

**What we'd borrow:**
- Move agent detection patterns from hardcoded TS to JSON/TOML data files
- Support local overrides (user-level detection rules without code changes)
- Add `region` concept (scan specific screen areas, not just "last N lines")
- Add `visible_working`/`visible_blocker`/`visible_idle` confidence signals
- Add OSC title/progress matching (terminal title sequences as a detection source)

**Stoa impact:** Would make agent detection more robust, more maintainable,
and extensible without deploys. Currently adding/fixing a provider's status
detection is a multi-file code change. With manifests, it's a data file edit.

**Estimated effort:** 3-5 days. The status detector is already reading the
rendered screen — the work is refactoring the matchers from code to data.

---

### BORROW #2: Agent State Event System with Confidence Signals (HIGH impact, LOW effort)

**What Herdr does:** Beyond simple Working/Idle/Blocked states, Herdr tracks
rich confidence metadata per pane:

```rust
pub struct AgentDetection {
    pub state: AgentState,           // Idle, Working, Blocked, Unknown
    pub skip_state_update: bool,     // Agent is in a transcript viewer, not live
    pub visible_idle: bool,          // Screen shows live idle chrome
    pub visible_blocker: bool,       // Screen shows live UI needing input
    pub visible_working: bool,       // Screen shows live working chrome
}
```

The system also has **debouncing**: `AGENT_PENDING_IDLE_CONFIRMATIONS = 3`
— a working-to-idle transition requires 3 consecutive idle detections
(100ms apart) before publishing, preventing flicker during spinner redraws.

**Why Stoa needs this:** Stoa's status transitions can be noisy. The
debouncing and confidence signals would make the Fleet Board and notification
system more accurate. The `skip_state_update` concept (detecting when an agent
is showing a transcript/history viewer vs. live state) would prevent false
idle readings.

**What we'd borrow:**
- Add confidence signals to `SessionStatus` (visible_working, visible_blocker)
- Add `skip_state_update` concept for agents showing non-live views
- Implement transition debouncing (require N consecutive readings before
  publishing a state change)
- Add a startup grace window (Herdr uses 3s — don't classify state during
  agent startup)

**Estimated effort:** 1-2 days. Add fields to the status detector, add a
debounce wrapper around the broadcaster.

---

### BORROW #3: Agent-to-Agent Socket API (HIGH impact, HIGH effort)

**What Herdr does:** This is Herdr's killer feature for multi-agent work.
The socket API lets agents drive each other:

```
agent start <name> <kind> [-- native args]   # Launch agent in existing pane
agent prompt <target> <text>                  # Send prompt, don't wait for response
agent wait <target> --state blocked           # Block until agent reaches state
agent read <target> --source detection        # Read screen output
agent send-keys <target> <keys>               # Send semantic key events
agent list                                    # All live agents with state
agent explain <target> --json                 # Debug detection reasoning
```

Agents can: split panes, start sub-agents, wait for them to hit blocked/done,
read their output, and respond to their prompts. The bundled `SKILL.md` teaches
agents how to use this surface.

**Why Stoa needs this:** Stoa's Fleet system orchestrates agents at a high
level (epic allocation, approval gates) but doesn't give agents a
peer-to-peer coordination surface. An agent can't currently say "start a
sub-agent in a new pane, wait for it to finish, read its output, and
incorporate the result." The Fleet does this at the orchestration layer, but
not at the agent layer.

**What we'd borrow:**
- Expose a REST/WS API for agent-to-agent operations (prompt, read, wait)
- Add `wait` semantics (block until a session reaches a specific state)
- Add agent session identity tracking (resume IDs, session paths)
- Ship a "Stoa skill" that teaches agents to use this surface

**Stoa impact:** Would enable true agent-to-agent delegation within Stoa
sessions, complementing the Fleet's higher-level orchestration. An agent
could spawn a sub-agent for a specific subtask and wait for its result
without human intervention.

**Estimated effort:** 5-8 days. Needs new API routes, a wait/poll mechanism,
session identity tracking, and the skill document.

---

### BORROW #4: Git Worktree-Backed Workspaces (MEDIUM impact, MEDIUM effort)

**What Herdr does:** Workspaces can be linked to git worktrees. `herdr worktree
create` generates a worktree with a poetic branch name
(`worktree/brave-river-a1b2`), and the workspace inherits the worktree's
directory. Worktree parent/child relationships are tracked and visualized in
the sidebar. This enables parallel agent work on different branches without
checkout conflicts.

**Why Stoa needs this:** Stoa has a `/api/worktrees` route but it's not a
first-class concept in the UI. For Fleet workers running in parallel, each
worker should ideally work in its own worktree to avoid file conflicts.
Making worktree-backed sessions a first-class concept would:
- Enable safe parallel agent work (each agent on its own branch)
- Provide natural isolation for Fleet workers
- Allow easy cleanup (delete the worktree = clean up the workspace)

**What we'd borrow:**
- Make worktree creation a first-class session-creation option
- Show worktree relationships in the session list (parent/child grouping)
- Auto-generate branch names for ephemeral work
- Add "merge worktree" workflow (merge the branch back, clean up)

**Estimated effort:** 3-4 days. The worktree API exists; the work is UI
integration and Fleet worker integration.

---

### BORROW #5: Plugin Architecture (LOW priority, HIGH effort)

**What Herdr does:** Plugins are TOML-manifested extensions that can:
- Register actions (context-menu items with commands)
- Hook into events (pane.created, agent.detected, etc.)
- Inject custom panes (sidebar widgets, custom views)
- Handle custom link schemes
- Run build steps and startup hooks

The plugin runtime injects context via environment variables
(`HERDR_PLUGIN_ID`, `HERDR_PLUGIN_CONTEXT_JSON`, `HERDR_SOCKET_PATH`) so plugins
can call back into Herdr's API. There's a marketplace with a Cloudflare Worker
backend tracking star history for trending plugins.

**Why this is lower priority:** Stoa's architecture (Next.js web app) already
has a natural extension point via its API routes. A full plugin system is
significant scope. However, a **lightweight version** (event webhooks +
custom actions) could be valuable for integrations.

**What we'd borrow (lightweight version):**
- Event webhook system (POST to a URL when agent state changes)
- Custom action registration (add items to the session context menu)
- Plugin context injection (pass session/pane info to external scripts)

**Estimated effort:** 5-7 days for the lightweight version.


## 4. What NOT to Borrow

- **Terminal multiplexer core** — Stoa's value is the web UI; rebuilding the
  terminal layer in Rust would be a rewrite, not an enhancement.
- **TUI rendering** — Stoa's web UI is the point; a TUI would be a regression.
- **Vendored libghostty-vt** — Stoa uses xterm.js in the browser; the VT
  emulator is a browser concern, not a server concern.
- **Native binary distribution** — Stoa's npm/web deployment model is simpler
  for users; don't add a Rust build chain.
- **SSH remote attach** — Stoa's web server already provides remote access
  from any browser, which is strictly more accessible than SSH.


## 5. The Real Question: Can They Run Together?

**Yes, and this is the most interesting option.** Herdr is a terminal
runtime; Stoa is a web cockpit. They operate at different layers:

```
┌─────────────────────────────────────────────┐
│  Stoa Web UI (browser, phone, tablet)        │
│  Fleet orchestration, analytics, dispatch     │
├─────────────────────────────────────────────┤
│  Stoa Server (Node.js)                        │
│  Session management, API routes, WebSocket    │
├───────────────┬─────────────────────────────┤
│  tmux backend │  pty backend (node-pty)      │
├───────────────┼─────────────────────────────┤
│  OR: Herdr backend (via socket API)           │
│  Herdr owns the terminals, Stoa drives them   │
│  through Herdr's JSON socket API              │
└─────────────────────────────────────────────┘
```

Herdr's socket API (`herdr pane list`, `herdr agent read`, `herdr agent wait`,
etc.) is a **clean integration boundary**. A new Stoa session backend could
talk to Herdr's socket instead of tmux/node-pty directly, gaining Herdr's
superior agent detection, persistence, and agent-to-agent coordination for
free, while keeping Stoa's web UI, Fleet, analytics, and dispatch.

This would be the **PtyTransport** pattern Stoa already has
(`LocalTransport` vs `HostTransport`): a `HerdrTransport` that proxies
session operations through Herdr's socket API.

**However:** This is a significant integration effort and only makes sense
if Herdr achieves sufficient adoption and stability on Windows (currently
in beta). For now, borrowing the architectural patterns is higher ROI.


## 6. Recommended Action Plan

### Phase 1: Quick wins (1-2 sprints)
1. **Agent state debouncing + confidence signals** (BORROW #2) — 1-2 days,
   immediate improvement to Fleet Board accuracy and notification quality.
2. **Start the manifest-based detection refactor** (BORROW #1) — 3-5 days,
   makes provider detection maintainable and extensible without deploys.

### Phase 2: Medium features (2-3 sprints)
3. **Worktree-backed sessions** (BORROW #4) — 3-4 days, enables safe parallel
   Fleet worker isolation.
4. **Agent-to-agent API surface** (BORROW #3) — 5-8 days, enables peer-to-peer
   agent delegation within Stoa sessions.

### Phase 3: Evaluate integration (ongoing)
5. **Monitor Herdr's Windows stability** — If Herdr reaches stable Windows
   support, prototype a `HerdrTransport` session backend that proxies through
   Herdr's socket API.
6. **Plugin system** (BORROW #5) — Only if there's concrete user demand for
   custom integrations.

### What NOT to do
- Do NOT rewrite Stoa's terminal layer in Rust.
- Do NOT replace the web UI with a TUI.
- Do NOT abandon Stoa's Fleet/analytics/dispatch capabilities — they are the
  differentiation.


## 7. Technical Reference: Herdr's Architecture

### Source structure (235 files, ~211K LOC)
```
src/
├── api/           # JSON socket API server + schema (schemars-derived)
│   ├── schema/    # Type definitions for all API requests/responses/events
│   ├── server/    # Server implementation, client accept, graphics streaming
│   ├── event_hub.rs
│   ├── status.rs
│   ├── subscriptions.rs
│   └── wait.rs    # Agent wait/poll implementation
├── app/           # Application state + input handling
│   ├── api/       # API method handlers (panes, tabs, workspaces, plugins)
│   ├── input/     # Input modes (terminal, prefix, navigate, copy, mouse)
│   └── state.rs   # AppState — pure data, testable without PTYs
├── cli/           # CLI command implementations
│   ├── agent.rs   # agent start/prompt/wait/read/send-keys/explain
│   ├── pane.rs    # pane split/focus/resize/read/send-text/send-keys
│   ├── workspace.rs
│   ├── tab.rs
│   ├── worktree.rs
│   ├── plugin.rs
│   ├── integration.rs
│   └── server.rs
├── config/        # TOML config (keybinds, theme, model, sidebar, sound)
├── detect/        # Agent state detection engine
│   ├── manifests/ # 19 TOML files, one per agent
│   ├── manifest.rs      # Manifest loading, caching, hot-reload
│   └── manifest_update.rs # Remote manifest update mechanism
├── integration/   # Agent integrations (hooks that improve detection)
├── pane/          # Pane state, agent detection, cursor, OSC
├── persist/       # Session save/restore (workspace, layout, history)
├── platform/      # OS-specific code (linux, macos, windows, fallback)
├── pty/           # PTY actor + backend (unix + windows ConPTY)
├── remote/        # SSH thin-client bridge
├── server/        # Server lifecycle, headless mode, notifications
├── terminal/      # Terminal emulation (vendored libghostty-vt)
├── ui/            # TUI rendering (ratatui)
└── workspace/     # Workspace state + git integration
```

### Key architectural principles (from AGENTS.md)
1. **State separated from runtime** — AppState is pure data, testable
   without PTYs or async.
2. **Render is pure** — compute_view() handles geometry; render() only draws.
3. **No god objects** — modules split by concern.
4. **Platform code isolated** — OS-specific code in platform/<os>.rs only.
5. **Detection is decoupled** — reads screen snapshot, never touches parser.
6. **Screen detection is evidence-based** — explicit AND/OR gates from
   visible controls, not whole-pane text matching.
7. **Runtime/client boundary** — migrating toward server-owned protocol with
   TUI as one client; new work should not deepen TUI coupling.

### Agent detection detail
The detection engine takes a `DetectionInput` (screen text + OSC title +
OSC progress) and evaluates rules from manifests in priority order. Each rule
specifies:
- `region`: Where to look (`bottom_non_empty_lines(N)`,
  `after_last_horizontal_rule`, `osc_title`, `full_screen`)
- `state`: What state this rule indicates (working/blocked/idle/unknown)
- `priority`: Higher = evaluated first (1100 = highest)
- `matchers`: `contains` (AND), `any` (OR), `regex`, `line_regex`
- `visible_*` flags: Confidence signals for source arbitration
- `skip_state_update`: For transcript/history viewers

The system has three detection sources with arbitration:
1. **Screen detection** (manifests) — fallback, works for all agents
2. **Integration reports** (hooks) — authoritative when installed
3. **OSC sequences** — terminal title/progress for working state

### Plugin system detail
Plugins declare a TOML manifest with:
- `build`: Build steps run on install
- `startup`: One-shot hooks after server startup
- `actions`: Context-menu items with commands
- `events`: Event hooks (`on: "pane.created"`, etc.)
- `panes`: Custom sidebar panes with placement
- `link_handlers`: Custom URL scheme handlers

Plugin commands run as subprocesses with injected environment:
- `HERDR_ENV=1`, `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_CONTEXT_JSON`
- `HERDR_SOCKET_PATH` (so plugins can call back into Herdr's API)
- `HERDR_BIN_PATH` (path to the herdr binary)

### Session persistence
- State stored at `~/.config/herdr/session.json`
- Pane screen history at `session-history.json` (optional)
- Installed plugins at `plugins.json`
- Named sessions: `~/.config/herdr/sessions/<name>/`
- Full workspace/tab/pane/layout/cwd restore on reattach

### Remote attach
- `herdr --remote <host>`: SSH thin-client
- Launches a local Herdr client that connects to a remote Herdr server
  over SSH stdio bridge
- Remote server auto-started if not running
- Protocol version negotiation on connect
- Windows can attach to Unix hosts (not vice-versa yet)
