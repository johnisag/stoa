# Stoa

**Stoa is a self-hosted cockpit for running AI coding agents in real terminals — from any browser, including your phone.**

Point it at a repo, pick an agent (Claude Code, Codex, Hermes, Kilo Code, or Kimi Code), and Stoa spawns a real terminal session you can watch stream live, steer, and reconnect to from anywhere on your network. It runs **natively on Windows, macOS, and Linux** — no WSL or tmux required on Windows — and your sessions keep running even after you close the tab.

The in-app **Guide** (compass icon in the sidebar) gives a plain-English tour of every feature.

## Features

**Run a fleet**

- **Live wall** — watch every agent's terminal at once in a read-only grid, streamed over WebSockets (no polling).
- **Multi-repo workspace** — open many repos as one session, with a worktree per sub-repo and a session-scoped Git panel.
- **Worktree-conflict warning** — get warned when two live sessions share a checkout and could overwrite each other's edits.
- **Fork** — branch any agent's conversation: natively for Claude (full history), via a scrollback fallback for every other agent (see [Supported Agents](#supported-agents)).
- **Cross-session output search** — find a session by what its agent actually said (⌘K → Output), e.g. _"which agent hit a `TypeError`?"_ (Claude transcripts today).

**Coordinate them**

- **Shared fleet memory** — a key→value scratchpad agents read and write over MCP to pass interface contracts and gotchas across worktrees.
- **Notes** — a shared markdown knowledge base you edit in a dialog and agents read/write over the same endpoint.
- **Inter-agent channels** — direct 1:1 messages between sessions (pull by default; opt in to inject a message into the recipient's terminal at its next turn boundary).

**Automate the work**

- **Visual workflow builder** — compose pipelines on a drag-and-drop DAG canvas, saved and reloadable.
- **Dispatch** — turn GitHub issues into reviewed, merged PRs autonomously, with a 3-critic review gate, a self-rebasing merge train, and conflict-free parallel task splitting.
- **Scheduler** — fire a prompt into a session once or hourly/daily/weekly (a nightly test run, a scheduled summary), enqueued to land at the session's next idle turn.
- **Custom commands** — author a slash command in the UI; Stoa writes it to the agent's native command dir (`~/.claude/commands/`) so it becomes a real `/name` the terminal autocompletes.
- **Ask / Command Stoa** — drive Stoa itself in plain language from a chatbox.

**Keep it running unattended**

- **Self-healing watchdog** (opt-in) — reaps a hung worker before it stalls the fleet, and pages you when a session wedges (spinner never settles).
- **Rate-limit auto-resume** (opt-in) — picks a parked session back up the moment its limit resets, capped per-day and skipped while a session is still working.
- **Spend tracking** — estimated token cost per session against per-session budget caps, with a daily history that persists after a session is deleted.
- **Offline queue** — stashes a prompt you send in a dead spot on-device and replays it (de-duplicated) the moment you're back online.

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

> **Session persistence:** Sessions survive browser disconnects everywhere. The
> underlying terminal process also survives a Stoa server restart — via tmux on
> macOS/Linux, and via the Tier-2 pty-host daemon (default-on) on Windows.
> Agent-level resume after restart is guaranteed for Claude (its resume id is
> read from on-disk project files). For Hermes and Kimi Code the resume id is
> captured from the startup banner and is lost once the banner scrolls off, so
> re-attached sessions may resume as fresh conversations if the banner was not
> captured before the restart. If the daemon is unavailable, Windows falls back
> to Tier-1 (in-process), where sessions survive disconnects but not a server
> restart.

### Prerequisites

- Node.js 24+
- tmux (macOS/Linux only — Windows uses the native pty backend)
- [ripgrep](https://github.com/BurntSushi/ripgrep) (for code search - auto-installed by installer script, or run `stoa update`)
- At least one AI CLI: [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), Hermes, [Kilo Code](https://github.com/Kilo-Org/kilocode), or [Kimi Code](https://github.com/MoonshotAI/kimi-code)

## Supported Agents

| Agent       | Resume | Fork          | Auto-Approve                                 |
| ----------- | ------ | ------------- | -------------------------------------------- |
| Claude Code | ✅     | ✅ native     | `--dangerously-skip-permissions`             |
| Codex       | ❌     | ✅ scrollback | `--dangerously-bypass-approvals-and-sandbox` |
| Hermes      | ✅     | ✅ scrollback | `--yolo`                                     |
| Kilo Code   | ❌     | ✅ scrollback | —                                            |
| Kimi Code   | ✅     | ✅ scrollback | `--yolo`                                     |

_**Resume**/**Fork** reflect what Stoa manages per session, not the CLI's raw
capability. **Fork** branches a conversation: Claude does it **natively**
(`--fork-session`, the full history); every other agent forks via a
**scrollback** fallback — a fresh session seeded with the parent's recent
terminal transcript as a "continue from here" prompt (#11). **Auto-Approve** is the
flag Stoa passes when you enable "skip permissions". Hermes resume works by
capturing its session id from the startup banner. Codex resume and its native
`codex fork` subcommand (today Codex forks via the scrollback fallback) are
planned — see [docs/ROADMAP.md](docs/ROADMAP.md). **Kimi Code**
resume works by capturing its session id from its startup banner, exactly like
Hermes. **Kilo Code** launches as a real terminal session like any other agent;
its per-session resume capture is a follow-up._

## CLI Commands

```bash
stoa run       # Start and open browser
stoa start     # Start in background
stoa stop      # Stop server
stoa status    # Show URLs
stoa logs      # Tail logs
stoa update    # Update to latest
stoa doctor    # Preflight checks (Node, port, build, agents) with fix hints
```

`stoa doctor` is a quick environment preflight — it verifies your Node version,
that port 3011 is free (or Stoa is already running on it), the production build
and dependencies are present, and at least one agent CLI is installed, printing an
actionable hint for anything wrong. It exits non-zero if a hard requirement fails,
so it doubles as an install/CI gate.

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
