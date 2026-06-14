#!/bin/bash
set -e

echo "Stoa Setup"
echo "=============="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    echo "Install Node.js 24+ from https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 24 ]; then
    echo "Error: Node.js 24+ required (found v$NODE_VERSION)"
    exit 1
fi
echo "Node.js: $(node -v)"

# Check Git
if ! command -v git &> /dev/null; then
    echo "Error: Git is required but was not found"
    exit 1
fi
echo "Git: $(git --version)"

# tmux is only required on the tmux backend (the default on macOS/Linux). The pty
# backend (default on Windows, or via STOA_BACKEND=pty) does not need it.
if [ "${STOA_BACKEND:-}" != "pty" ]; then
    if ! command -v tmux &> /dev/null; then
        echo "Warning: tmux is not installed. It is required unless you set STOA_BACKEND=pty"
    else
        echo "tmux: $(tmux -V)"
    fi
fi

# At least one supported AI CLI should be available, but we no longer hard-require
# Claude — users may prefer Codex, Hermes, Kilo Code, or Kimi Code.
AGENTS=(claude codex hermes kilo kimi)
FOUND=()
for agent in "${AGENTS[@]}"; do
    if command -v "$agent" &> /dev/null; then
        FOUND+=("$agent")
    fi
done
if [ ${#FOUND[@]} -eq 0 ]; then
    echo "Warning: No supported AI agent CLI found (claude, codex, hermes, kilo, kimi). Install at least one before creating an agent session."
else
    echo "AI agents found: ${FOUND[*]}"
fi

# Check jq
if ! command -v jq &> /dev/null; then
    echo "Warning: jq is not installed (optional, for session ID parsing)"
    echo "Install: brew install jq (macOS) or apt install jq (Linux)"
fi

# Copy .env if needed
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo ""
        echo "Created .env from .env.example"
    fi
fi

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

echo ""
echo "Setup complete!"
echo "Run 'npm run dev' to start the development server"
