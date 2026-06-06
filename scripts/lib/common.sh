#!/usr/bin/env bash
# Common utilities for stoa scripts

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Logging
log_info() { echo -e "${BLUE}==>${NC} $1"; }
log_success() { echo -e "${GREEN}==>${NC} $1"; }
log_warn() { echo -e "${YELLOW}==>${NC} $1"; }
log_error() { echo -e "${RED}==>${NC} $1"; }

# OS Detection
detect_os() {
    case "$(uname -s)" in
        Darwin*)
            echo "macos"
            ;;
        Linux*)
            if [[ -f /etc/debian_version ]]; then
                echo "debian"
            elif [[ -f /etc/redhat-release ]]; then
                echo "redhat"
            else
                echo "linux"
            fi
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

# Check if running interactively
is_interactive() {
    [[ -t 0 ]] && [[ -t 1 ]]
}

# Prompt for yes/no
prompt_yn() {
    local prompt="$1"
    local default="${2:-y}"

    if ! is_interactive; then
        [[ "$default" == "y" ]]
        return
    fi

    local yn_prompt
    if [[ "$default" == "y" ]]; then
        yn_prompt="[Y/n]"
    else
        yn_prompt="[y/N]"
    fi

    read -p "$prompt $yn_prompt " -r response
    response="${response:-$default}"

    [[ "$response" =~ ^[Yy] ]]
}

# Process management helpers
get_pid() {
    local pid_file="$STOA_HOME/stoa.pid"
    if [[ -f "$pid_file" ]]; then
        local pid
        pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            echo "$pid"
            return 0
        fi
    fi
    return 1
}

is_running() {
    get_pid &>/dev/null
}

# ---- Service-manager helpers (launchd on macOS, systemd --user on Linux) ----
# These let `stoa update` (and friends) drive the SAME supervisor that `stoa
# enable` set up, instead of spawning an un-managed background copy.

# Path to the auto-start unit for the current platform.
service_unit_path() {
    if [[ "$OS" == "macos" ]]; then
        echo "$HOME/Library/LaunchAgents/com.stoa.plist"
    else
        echo "$HOME/.config/systemd/user/stoa.service"
    fi
}

# True if auto-start (launchd/systemd) is configured.
service_enabled() {
    [[ -f "$(service_unit_path)" ]]
}

# Stop Stoa through its service manager so it isn't auto-relaunched mid-update.
stop_service() {
    log_info "Stopping the Stoa service..."
    if [[ "$OS" == "macos" ]]; then
        launchctl unload "$(service_unit_path)" 2>/dev/null || true
    else
        systemctl --user stop stoa 2>/dev/null || true
    fi
    # Belt-and-suspenders: a manually `stoa start`ed instance isn't owned by the
    # service manager, so make sure nothing is left holding the port. Re-validate
    # liveness right before SIGKILL (like cmd_stop) so a reaped/recycled pid from
    # the supervisor teardown above can't be hit.
    if is_running; then
        local pid
        pid=$(get_pid)
        kill "$pid" 2>/dev/null || true
        sleep 1
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
        fi
    fi
    rm -f "$PID_FILE"
}

# Start Stoa through its service manager (re-reads the unit, so new code is live).
start_service() {
    log_info "Starting the Stoa service..."
    if [[ "$OS" == "macos" ]]; then
        launchctl load "$(service_unit_path)" 2>/dev/null || true
    else
        systemctl --user start stoa 2>/dev/null || true
    fi
}

# Get Tailscale IP if available
get_tailscale_ip() {
    if command -v tailscale &> /dev/null; then
        tailscale ip -4 2>/dev/null | head -1
    fi
}
