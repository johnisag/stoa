# Stoa

**Stoa is a self-hosted cockpit for running AI coding agents in real terminals — from any browser, including your phone.**

Point it at a repo, pick an agent (Claude Code, Codex, or Hermes), and Stoa spawns a real terminal session you can watch stream live, steer, and reconnect to from anywhere on your network. It runs **natively on Windows, macOS, and Linux** — no WSL or tmux required on Windows — and your sessions keep running even after you close the tab.

It's built for the way agents actually work: run several side by side, dictate prompts by voice, search the codebase, browse and attach files, review diffs and open PRs, manage dev servers, and coordinate conductor/worker agent fleets — all from a mobile-first UI.

## Installation

> **Heads-up:** Stoa isn't published to npm yet, so `npm install -g @johnisag/stoa`
> won't work — use one of the methods below (they clone the repo). npm
> distribution is planned.

### Quick install (curl)

Installs prerequisites, clones the repo, and builds:

```bash
curl -fsSL https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.sh | bash
stoa start
```

### Manual install

```bash
git clone https://github.com/johnisag/stoa
cd stoa
npm install
npm run dev  # http://localhost:3011
```

### Windows (native)

Stoa runs natively on Windows — no WSL or tmux required.

Requires Node.js 20+ and Git. Install them via [winget](https://learn.microsoft.com/windows/package-manager/winget/) if needed:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Then clone and run:

```powershell
git clone https://github.com/johnisag/stoa
cd stoa
npm install --legacy-peer-deps
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

- Node.js 20+
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

- **Mobile-first** - Full functionality from your phone, not a dumbed-down responsive view
- **Multi-pane** - Run up to 4 agent sessions side-by-side
- **Voice-to-text** - Dictate prompts to your sessions hands-free
- **Code search** - Fast, syntax-highlighted codebase search (Cmd+K)
- **File picker** - Browse and attach files, with direct upload from mobile
- **Git built in** - Status, diffs, commits, PRs, and GitHub clone — from the UI
- **Git worktrees** - Isolated branches with auto-setup
- **Dev servers** - Start/stop Node.js and Docker servers per project
- **Session orchestration** - Coordinate conductor/worker agent fleets via MCP

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
rebuilds, and restarts. It pins to `main`, and if anything fails it restarts the
existing version — so a bad update never leaves the server down.

> **Heads-up:** `stoa update` refuses to run if the install tree has uncommitted
> changes (it won't clobber your edits). Keep your local config in `.env` (which
> is gitignored) rather than editing tracked files, and updates stay frictionless.

## Configuration

Stoa reads configuration from the environment, and from a gitignored `.env` file
in the repo root (copy `.env.example` to `.env` to start):

```bash
cp .env.example .env   # then edit
```

| Variable    | Default | Purpose                                                   |
| ----------- | ------- | --------------------------------------------------------- |
| `STOA_PORT` | `3011`  | Port the server listens on (and the URL the CLI reports). |
| `PORT`      | `3011`  | Same; `STOA_PORT` takes precedence if both are set.       |

A value already exported in your shell **overrides** the `.env` file, so
`STOA_PORT=4000 stoa start` is a one-off override. Set it once in `.env` and the
CLI keeps the displayed and listening port in sync across `start`, `status`, and
the post-`update` restart. (Note: `#` only starts a comment at the **start** of a
line in `.env`; inline comments are not stripped.)

## Local development & dogfooding

Run your own always-current instance on a custom port:

```bash
git clone https://github.com/johnisag/stoa && cd stoa
npm install --legacy-peer-deps
npm link                       # puts `stoa` on your PATH
printf 'STOA_PORT=3022\n' > .env
npm run build
stoa start                     # serves on http://localhost:3022
```

Then, to stay current as the project evolves:

```bash
stoa update                    # pulls main, rebuilds, restarts — still on 3022
```

Because `.env` is gitignored, your port (and any other local config) survives
every update untouched.

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
