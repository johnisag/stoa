# Stoa

**Stoa is a self-hosted cockpit for running AI coding agents in real terminals — from any browser, including your phone.**

Point it at a repo, pick an agent (Claude Code, Codex, or Hermes), and Stoa spawns a real terminal session you can watch stream live, steer, and reconnect to from anywhere on your network. It runs **natively on Windows, macOS, and Linux** — no WSL or tmux required on Windows — and your sessions keep running even after you close the tab.

It's built for the way agents actually work: run several side by side, dictate prompts by voice, search the codebase, browse and attach files, review diffs and open PRs, manage dev servers, and coordinate conductor/worker agent fleets — all from a mobile-first UI.

And when you're ready to scale past hands-on, **Dispatch** turns GitHub issues into finished, reviewed, merged PRs **autonomously** — with a fleet that reviews itself, lands its own work, steers around stalls, verifies its changes, and learns from every mistake. You define the work and render the verdicts; the machine does everything in between.

## Installation

> **Heads-up:** Stoa isn't published to npm yet, so `npm install -g @johnisag/stoa`
> won't work — use one of the methods below (they clone the repo). npm
> distribution is planned.

### Quick install (curl)

Installs prerequisites, clones the repo, installs dependencies, builds for
production, and links the `stoa` command:

```bash
curl -fsSL https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.sh | bash
stoa start
```

### Manual install

```bash
git clone https://github.com/johnisag/stoa
cd stoa
npm install --include=dev --legacy-peer-deps
npm run build
npm start  # http://localhost:3011
```

### Windows (native)

Stoa runs natively on Windows — no WSL or tmux required.

Requires Node.js 24+ and Git. Install them via [winget](https://learn.microsoft.com/windows/package-manager/winget/) if needed:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Then clone and run:

```powershell
git clone https://github.com/johnisag/stoa
cd stoa
npm install --include=dev --legacy-peer-deps
npm run build
npm start  # or: stoa start
```

Or use the PowerShell installer:

```powershell
irm https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.ps1 | iex
```

On Windows the native pty backend is selected automatically (no tmux/WSL needed). Set `STOA_BACKEND=tmux|pty` to override the choice on any platform.

> **Session persistence:** Sessions survive browser disconnects everywhere. They
> also survive a Stoa server restart — via tmux on macOS/Linux, and via the
> Tier-2 pty-host daemon (default-on) on Windows. If the daemon is unavailable,
> Windows falls back to Tier-1 (in-process), where sessions survive disconnects
> but not a server restart.

### Prerequisites

- Node.js 24+
- tmux (macOS/Linux only — Windows uses the native pty backend)
- [ripgrep](https://github.com/BurntSushi/ripgrep) (for code search - auto-installed by installer script, or run `stoa update`)
- At least one AI CLI: [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), or Hermes

## Supported Agents

| Agent       | Resume | Fork | Auto-Approve                                 |
| ----------- | ------ | ---- | -------------------------------------------- |
| Claude Code | ✅     | ✅   | `--dangerously-skip-permissions`             |
| Codex       | ❌     | ❌   | `--dangerously-bypass-approvals-and-sandbox` |
| Hermes      | ❌     | ❌   | `--yolo`                                     |

_**Resume**/**Fork** reflect what Stoa manages per session, not the CLI's raw
capability. **Auto-Approve** is the flag Stoa passes when you enable "skip
permissions". Hermes resume is planned — see [docs/ROADMAP.md](docs/ROADMAP.md)._

## Features

### The cockpit

- **Mobile-first** - Full functionality from your phone, not a dumbed-down responsive view
- **Multi-pane** - Run up to 4 agent sessions side-by-side
- **Voice-to-text** - Dictate prompts to your sessions hands-free
- **Code search** - Fast, syntax-highlighted codebase search (Cmd+K)
- **File picker** - Browse and attach files, with direct upload from mobile
- **Git built in** - Status, diffs, commits, PRs, and GitHub clone — from the UI
- **Git worktrees** - Isolated branches with auto-setup
- **Dev servers** - Start/stop Node.js and Docker servers per project
- **Session orchestration** - Coordinate conductor/worker agent fleets via MCP
- **Workflows** - Declarative agent-pipeline DAGs: fan out N agents (each in its own worktree, on its own model), fan in, and gate on the results — from a template catalog

### The autonomous fleet — Dispatch

Turn a GitHub issue into a finished, reviewed, merged PR — at fleet scale, from your phone. Each capability is **opt-in per repo**:

- **Issue → PR, autonomously** - Dispatch ingests issues, spawns a worker in an isolated worktree, opens a PR, and drives it through the whole ceremony
- **3-critic review gate** - Three independent agents review each PR on a distinct lens (correctness · conventions · simplicity); a fixer addresses what they flag
- **Verdict Inbox** - One fleet-wide review queue across every worker and auto-mode session — per-lens findings read live, with merge / retry / dismiss in place, built for the phone
- **Merge Train** - A ready-but-conflicting PR rebases, resolves, and re-pushes _itself_ back to landable instead of paging you
- **Conflict-aware decomposition** - Paste a spec; a planner splits it into tasks that each own a disjoint part of the codebase, so several agents work in parallel without colliding (the scheduler refuses to co-schedule a collision)
- **Verification harness** - Runs your repo's typecheck/test/build in each worker's worktree and gates the merge on real evidence — especially valuable for repos with no CI
- **Auto-steer** - Resumes a rate-limited agent when its window resets, answers routine prompts, and pages you only when one is genuinely stuck in an error loop
- **Fleet memory** - The repo remembers every blocking review finding and tells the next agent up front, so the fleet stops repeating mistakes

Everything autonomous is **opt-in, fail-closed, and traced**, runs natively on Windows/macOS/Linux, and reuses the same ceremony — so a hand-driven session and a fully autonomous worker land through the identical gate.

## CLI Commands

```bash
stoa run       # Start and open browser
stoa start     # Start in background
stoa stop      # Stop server
stoa status    # Show URLs
stoa logs      # Tail logs
stoa update    # Update to latest
```

## Updating

```bash
stoa update
```

Stops the server (if running), pulls the latest `main`, reinstalls dependencies,
rebuilds, and restarts after the production build artifacts are verified. It
pins to `main`; if an update fails, it refuses to start from an incomplete build.

## Mobile Access

Use [Tailscale](https://tailscale.com) for secure access from your phone:

1. Install Tailscale on your dev machine and phone
2. Sign in with the same account
3. Access `http://100.x.x.x:3011` from your phone

## Documentation

See [AGENTS.md](AGENTS.md) for the architecture and contributor principles, and
[docs/](docs/) for setup notes and known issues.

## License

MIT License - Free and open source. See [LICENSE](LICENSE) for full terms.

Stoa is a fork of the original AgentOS project; the upstream copyright is
retained in [LICENSE](LICENSE) per the MIT terms.
