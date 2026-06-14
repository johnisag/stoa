# Stoa

**Stoa is a self-hosted cockpit for running AI coding agents in real terminals — from any browser, including your phone.**

Point it at a repo, pick an agent (Claude Code, Codex, Hermes, Kilo Code, or Kimi Code), and Stoa spawns a real terminal session you can watch stream live, steer, and reconnect to from anywhere on your network. It runs **natively on Windows, macOS, and Linux** — no WSL or tmux required on Windows — and your sessions keep running even after you close the tab.

It's built for the way agents actually work: run several side by side from a mobile-first UI. Open many repos at once as a **multi-repo workspace** (one session, a worktree per sub-repo) with a session-scoped Git panel. Compose pipelines in the **visual workflow builder** (drag-and-drop DAG canvas, saved and reloadable). Drive Stoa itself in plain language with the **Ask / Command Stoa** chatbox. And — when you're ready to scale past hands-on — let **Dispatch** turn GitHub issues into reviewed, merged PRs autonomously: the fleet reviews its own PRs (a 3-critic gate), lands them (a self-rebasing merge train), splits a spec into conflict-free parallel tasks, verifies its changes, and learns from every review.

For a plain-English tour of every feature, open the **Guide** (the compass icon in the sidebar) once Stoa is running.

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
- At least one AI CLI: [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), Hermes, [Kilo Code](https://github.com/Kilo-Org/kilocode), or [Kimi Code](https://github.com/MoonshotAI/kimi-code)

## Supported Agents

| Agent       | Resume | Fork | Auto-Approve                                 |
| ----------- | ------ | ---- | -------------------------------------------- |
| Claude Code | ✅     | ✅   | `--dangerously-skip-permissions`             |
| Codex       | ❌     | ❌   | `--dangerously-bypass-approvals-and-sandbox` |
| Hermes      | ✅     | ❌   | `--yolo`                                     |
| Kilo Code   | ❌     | ❌   | —                                            |
| Kimi Code   | ❌     | ❌   | `--yolo`                                     |

_**Resume**/**Fork** reflect what Stoa manages per session, not the CLI's raw
capability. **Auto-Approve** is the flag Stoa passes when you enable "skip
permissions". Hermes resume works by capturing its session id from the startup
banner. Codex resume/fork (its CLI exposes `codex resume`/`codex fork`
subcommands) is planned — see [docs/ROADMAP.md](docs/ROADMAP.md). **Kilo Code**
(the open-source agentic CLI) and **Kimi Code** (Moonshot AI's terminal coding
agent) launch as
real terminal sessions like any other agent; per-session resume/fork management
is not wired yet._

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
