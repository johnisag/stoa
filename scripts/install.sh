#!/usr/bin/env bash
#
# Stoa Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.sh | bash
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log_info() { echo -e "${BLUE}==>${NC} $1"; }
log_success() { echo -e "${GREEN}==>${NC} $1"; }
log_error() { echo -e "${RED}==>${NC} $1"; }

REPO_URL="https://github.com/johnisag/stoa.git"
INSTALL_DIR="$HOME/.stoa/repo"

echo ""
echo -e "${BOLD}Stoa Installer${NC}"
echo ""

# Check for git
if ! command -v git &> /dev/null; then
    log_error "git is required. Please install git first."
    exit 1
fi

# Clone or update repo
if [[ -d "$INSTALL_DIR" ]]; then
    log_info "Updating existing installation..."
    cd "$INSTALL_DIR"
    # Pin to main with guarded steps (mirror install.ps1 / `stoa update`) so a
    # diverged/off-main checkout fails with an actionable message, not a raw git
    # error aborting under set -e.
    git fetch origin --tags || { log_error "git fetch failed."; exit 1; }
    git checkout main || { log_error "git checkout main failed."; exit 1; }
    git pull --ff-only origin main || { log_error "git pull failed (local main may have diverged — move/remove colliding untracked files, or reclone ~/.stoa/repo)."; exit 1; }
else
    log_info "Downloading Stoa..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Run the install command
exec "$INSTALL_DIR/scripts/stoa" install
