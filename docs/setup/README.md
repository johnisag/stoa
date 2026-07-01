# Stoa Setup Guide

This guide covers installing and running Stoa on your machine.

## Quick Install (Recommended)

Run this one-liner to install Stoa:

```bash
curl -fsSL https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.sh | bash
```

The installer will:

1. Clone or update Stoa in `~/.stoa/repo`
2. Check for prerequisites (Node.js 24+, git, tmux) and offer to install any missing ones
3. Detect installed AI CLIs or prompt you to install one
4. Install dependencies with development build tools included
5. Build for production and verify the required `.next` artifacts exist
6. Link `stoa` into `~/.local/bin`

## Manual Install

If you prefer to install manually:

```bash
# Clone the repository
git clone https://github.com/johnisag/stoa ~/.stoa/repo
cd ~/.stoa/repo

# Install dependencies
npm install --include=dev --legacy-peer-deps

# Build for production
npm run build

# Start the server
npm start
```

## CLI Commands

After installation, use the `stoa` command to manage the server:

| Command          | Description                     |
| ---------------- | ------------------------------- |
| `stoa start`     | Start the server in background  |
| `stoa stop`      | Stop the server                 |
| `stoa restart`   | Restart the server              |
| `stoa status`    | Show status, PID, and URLs      |
| `stoa logs`      | Tail server logs                |
| `stoa update`    | Pull latest version and rebuild |
| `stoa uninstall` | Remove Stoa completely          |

## Prerequisites

The installer can automatically install these on macOS and Linux:

- **Node.js 24+** - JavaScript runtime
- **npm** - Package manager (comes with Node.js)
- **git** - Version control
- **tmux** - Terminal multiplexer for session management

### AI Coding CLIs

You need at least one AI coding CLI installed. The installer will prompt you to choose:

| CLI         | Provider  | Install Command                            |
| ----------- | --------- | ------------------------------------------ |
| Claude Code | Anthropic | `npm install -g @anthropic-ai/claude-code` |
| Codex       | OpenAI    | `npm install -g @openai/codex`             |
| Aider       | Multi-LLM | `pip install aider-chat`                   |
| Gemini CLI  | Google    | `npm install -g gemini-cli`                |

## Configuration

### Environment Variables

| Variable             | Default           | Description                                                                                                                           |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `STOA_HOME`          | `~/.stoa`         | Installation directory                                                                                                                |
| `STOA_PORT`          | `3011`            | Server port                                                                                                                           |
| `DB_PATH`            | `~/.stoa/stoa.db` | SQLite database path (defaults to `$STOA_HOME/stoa.db`, outside the repo clone)                                                       |
| `STOA_ENV_SNAPSHOTS` | `1` (on)          | Warm-cache a worktree's `node_modules` (in `$STOA_HOME/env-snapshots`) so sibling worktrees skip `npm install`. Set `0` to disable.\* |

\* Only `node_modules` is snapshotted. Disable (`STOA_ENV_SNAPSHOTS=0`) if a
project's `postinstall` writes files _outside_ `node_modules` that a copy wouldn't
reproduce. Restores are fail-open — any miss or copy error silently falls back to a
normal install, so this can only speed a launch up, never break one.

### Custom Port

```bash
# Start on a different port
STOA_PORT=8080 stoa start

# Or set permanently in the install directory
cd ~/.stoa/repo
cp .env.example .env
# edit .env and set STOA_PORT=8080
```

`STOA_PORT` is honored by `stoa start`, `stoa doctor`, **and** `npm run dev` (it is
bridged to `PORT` on startup; if both are set, `STOA_PORT` wins).

## Mobile Access with Tailscale

Stoa is designed for mobile access. The easiest way to access it from your phone is with [Tailscale](https://tailscale.com):

1. **Install Tailscale on your machine:**

   ```bash
   # macOS
   brew install tailscale

   # Linux
   curl -fsSL https://tailscale.com/install.sh | sh
   ```

2. **Start Tailscale and authenticate:**

   ```bash
   sudo tailscale up
   ```

3. **Get your Tailscale IP:**

   ```bash
   tailscale ip -4
   # Example: 100.64.0.1
   ```

4. **Install Tailscale on your phone** (iOS App Store / Google Play)

5. **Sign in with the same account**

6. **Access Stoa:**
   ```
   http://100.64.0.1:3011
   ```

The `stoa status` command will show your Tailscale URL if Tailscale is installed.

## Directory Structure

```
~/.stoa/
|-- repo/          # Cloned Stoa repository
|-- stoa.db        # SQLite database (sessions/history) — lives OUTSIDE repo/ so a
|                  #   re-clone or reset of repo/ can never destroy it
|-- stoa.pid       # PID file when running
`-- stoa.log       # Server logs
```

## Updating

```bash
stoa update
```

This will:

1. Stop the server if running
2. Pull the latest changes from git
3. Install any new dependencies
4. Rebuild for production
5. Restart the server if it was running

## Troubleshooting

### Server won't start

Check the logs:

```bash
stoa logs
```

Common issues:

- Port already in use: Change `STOA_PORT`
- Missing dependencies: Run `stoa install` again
- Node.js version: Ensure Node.js 24+ is installed

### Can't connect from phone

1. Ensure both devices are on the same Tailscale network
2. Check `stoa status` for the correct URL
3. Verify the server is running: `stoa status`
4. Check firewall settings if not using Tailscale

### Build fails

Try a clean reinstall:

```bash
stoa stop
rm -rf ~/.stoa/repo/node_modules
rm -rf ~/.stoa/repo/.next
stoa install
```

## Uninstalling

```bash
stoa uninstall
```

This removes:

- The `~/.stoa` directory
- Any launchd/systemd configuration created by older installs

The `stoa` CLI script itself is not removed. Delete it manually:

```bash
rm $(which stoa)
```
