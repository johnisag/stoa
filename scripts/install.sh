#!/usr/bin/env bash
#
# Stoa Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.sh | bash
#
#   # Opt in to the pinned release channel (checks out the latest verified
#   # release tag instead of the tip of main):
#   curl -fsSL .../scripts/install.sh | STOA_CHANNEL=release bash
#   # (or, when running the file directly)  bash install.sh --channel release
#
# CHANNEL (#56): default "main" keeps today's behavior — clone/track the main
# branch's HEAD. The OPT-IN "release" channel pins the checkout to the latest
# verified, immutable release tag (safer for production). Select it via the
# STOA_CHANNEL env var or a `--channel <main|release>` argument; the argument
# wins. Behavior is identical to the PowerShell installer (install.ps1).
#
# SECURITY NOTE: This installer fetches code from the internet and executes it.
# For production deployments, pin the remote script to an immutable release tag
# or SHA and verify checksums before execution. See SECURITY.md for details.
#

set -e

# ---------------------------------------------------------------------------
# Channel selection (#56) — default "main" (unchanged); "release" is opt-in.
# ---------------------------------------------------------------------------
CHANNEL="${STOA_CHANNEL:-main}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --channel)
            CHANNEL="${2:-}"
            shift 2
            ;;
        --channel=*)
            CHANNEL="${1#--channel=}"
            shift
            ;;
        *)
            shift
            ;;
    esac
done
# Normalize to lowercase and validate — a typo must not silently track main.
CHANNEL="$(printf '%s' "$CHANNEL" | tr '[:upper:]' '[:lower:]')"
if [[ "$CHANNEL" != "main" && "$CHANNEL" != "release" ]]; then
    printf '\033[0;31m==>\033[0m Unknown channel "%s". Use: main or release.\n' "$CHANNEL" >&2
    exit 1
fi

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
    git pull --ff-only
else
    log_info "Downloading Stoa..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Release channel (#56): pin the checkout to the latest verified release tag.
# Default "main" is a no-op here (the clone/pull above already left us on main).
if [[ "$CHANNEL" == "release" ]]; then
    log_info "Resolving the latest release tag (release channel)..."
    git fetch --tags --quiet
    # Newest semver-ish vMAJOR.MINOR.PATCH tag, ignoring anything else. `git tag`
    # with a version sort keeps this to git's own transport (no shell pipe soup):
    # list, filter to clean release tags, take the highest.
    latest_tag="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n 1)"
    if [[ -z "$latest_tag" ]]; then
        log_error "No verified release tag found. Re-run without --channel release (or with --channel main) to track main."
        exit 1
    fi
    log_info "Checking out release tag $latest_tag"
    git checkout --force "tags/$latest_tag"
fi

# Run the install command
exec "$INSTALL_DIR/scripts/stoa" install
