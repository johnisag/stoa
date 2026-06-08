#!/usr/bin/env bash
# Command implementations for stoa

cmd_install() {
    local use_local=false
    [[ "${1:-}" == "--local" ]] && use_local=true

    log_info "Installing Stoa..."
    echo ""

    # Check and install prerequisites
    check_and_install_prerequisites

    # Prompt for AI CLI installation
    prompt_ai_cli_install

    # Create directory structure
    mkdir -p "$STOA_HOME"

    # Clone, copy local, or update repo
    if [[ -d "$REPO_DIR" ]]; then
        if [[ "$use_local" == true ]]; then
            log_info "Updating from local source..."
            rsync -a --delete --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='*.db*' "$LOCAL_REPO/" "$REPO_DIR/"
        else
            log_info "Repository already exists, pulling latest..."
            cd "$REPO_DIR"
            git pull --ff-only
        fi
        cd "$REPO_DIR"
    else
        if [[ "$use_local" == true ]]; then
            log_info "Copying from local source..."
            rsync -a --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='*.db*' "$LOCAL_REPO/" "$REPO_DIR/"
            cd "$REPO_DIR"
            git init
        else
            log_info "Cloning repository..."
            git clone "$REPO_URL" "$REPO_DIR"
            cd "$REPO_DIR"
        fi
    fi

    # Install dependencies
    log_info "Installing dependencies..."
    # --include=dev: the build needs devDeps (next/tailwind/typescript); a shell
    # with NODE_ENV=production would otherwise omit them and break the build.
    npm install --include=dev --legacy-peer-deps

    # Build for production
    log_info "Building for production..."
    npm run build

    # If tmux was unavailable (e.g. non-admin macOS), persist the pty backend so
    # the first session doesn't fail trying to use the absent tmux backend. The
    # server self-loads .env at startup, so this is honored regardless of launcher.
    if [[ "${STOA_USE_PTY_BACKEND:-}" == "1" ]]; then
        if ! grep -qs '^STOA_BACKEND=' "$REPO_DIR/.env" 2>/dev/null; then
            echo "STOA_BACKEND=pty" >> "$REPO_DIR/.env"
            log_info "Set STOA_BACKEND=pty in $REPO_DIR/.env (tmux unavailable)."
        fi
    fi

    # Create CLI symlink (prefer ~/.local/bin to avoid sudo)
    log_info "Adding stoa to PATH..."
    local bin_dir="$HOME/.local/bin"
    local needs_path_update=false

    mkdir -p "$bin_dir"
    ln -sf "$REPO_DIR/scripts/stoa" "$bin_dir/stoa"

    # Check if ~/.local/bin is in PATH
    if [[ ":$PATH:" != *":$bin_dir:"* ]]; then
        needs_path_update=true
        # Add to shell profile
        local shell_profile=""
        if [[ -f "$HOME/.zshrc" ]]; then
            shell_profile="$HOME/.zshrc"
        elif [[ -f "$HOME/.bashrc" ]]; then
            shell_profile="$HOME/.bashrc"
        elif [[ -f "$HOME/.bash_profile" ]]; then
            shell_profile="$HOME/.bash_profile"
        fi

        if [[ -n "$shell_profile" ]]; then
            if ! grep -q 'export PATH="$HOME/.local/bin:$PATH"' "$shell_profile" 2>/dev/null; then
                echo '' >> "$shell_profile"
                echo '# Added by Stoa' >> "$shell_profile"
                echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$shell_profile"
            fi
        fi
    fi

    echo ""
    log_success "Stoa installed successfully!"
    echo ""

    if [[ "$needs_path_update" == true ]]; then
        echo "Note: ~/.local/bin was added to your PATH."
        echo "Run 'source ~/.zshrc' or restart your terminal, then:"
        echo ""
    fi

    echo "Next steps:"
    echo "  stoa start     Start the server"
    echo "  stoa enable    Auto-start on boot"
    echo "  stoa status    Show URLs"
}

cmd_start() {
    if is_running; then
        local pid
        pid=$(get_pid)
        log_warn "Stoa is already running (PID: $pid)"
        return 0
    fi

    if [[ ! -d "$REPO_DIR" ]]; then
        log_error "Stoa is not installed. Run 'stoa install' first."
        exit 1
    fi

    log_info "Starting Stoa..."

    cd "$REPO_DIR"

    # Ensure the log directory exists (LOG_FILE is now under ~/.stoa/logs/).
    mkdir -p "$(dirname "$LOG_FILE")"

    # Rotate log if too big (> 10MB)
    if [[ -f "$LOG_FILE" ]]; then
        local size
        size=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
        if [[ "$size" -gt 10485760 ]]; then
            mv "$LOG_FILE" "$LOG_FILE.old"
        fi
    fi

    # Start server in background
    nohup npm start >> "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"

    # Wait and verify
    sleep 2
    if ! ps -p "$pid" &> /dev/null; then
        log_error "Failed to start Stoa. Check logs: stoa logs"
        rm -f "$PID_FILE"
        exit 1
    fi

    log_success "Stoa started (PID: $pid)"
    echo ""
    echo "  Local:     http://localhost:$PORT"

    local ts_ip
    ts_ip=$(get_tailscale_ip)
    if [[ -n "$ts_ip" ]]; then
        echo "  Tailscale: http://$ts_ip:$PORT"
    fi
    echo ""
    echo "Run 'stoa logs' to view logs"
}

cmd_stop() {
    if ! is_running; then
        log_warn "Stoa is not running"
        return 0
    fi

    local pid
    pid=$(get_pid)
    log_info "Stopping Stoa (PID: $pid)..."

    kill "$pid" 2>/dev/null || true

    # Wait for graceful shutdown with progress
    local count=0
    printf "    Waiting for shutdown"
    while ps -p "$pid" &> /dev/null && [[ $count -lt 10 ]]; do
        printf "."
        sleep 1
        ((count++))
    done
    echo ""

    # Force kill if still running
    if ps -p "$pid" &> /dev/null; then
        log_warn "Force killing..."
        kill -9 "$pid" 2>/dev/null || true
        sleep 1
    fi

    # Verify it's actually dead before clearing the pid file — a failed kill
    # (privilege mismatch) must not let a following restart/update stack a second
    # server on the same port.
    if ps -p "$pid" &> /dev/null; then
        log_error "Failed to stop Stoa — PID $pid is still alive. Kill it manually (kill -9 $pid)."
        exit 1
    fi

    rm -f "$PID_FILE"
    log_success "Stoa stopped"
}

cmd_restart() {
    cmd_stop
    sleep 1
    cmd_start
}

cmd_run() {
    # Start if not running
    if ! is_running; then
        cmd_start
    fi

    # Wait a moment for server to be ready
    sleep 1

    local url="http://localhost:$PORT"
    log_info "Opening $url..."

    # Open in browser
    if [[ "$OS" == "macos" ]]; then
        open "$url"
    elif command -v xdg-open &> /dev/null; then
        xdg-open "$url"
    elif command -v wslview &> /dev/null; then
        wslview "$url"
    else
        log_warn "Could not detect browser. Open manually: $url"
    fi
}

cmd_status() {
    echo ""
    if is_running; then
        local pid
        pid=$(get_pid)
        echo -e "  Status:    ${GREEN}Running${NC} (PID: $pid)"
        echo "  Port:      $PORT"
        echo "  Local:     http://localhost:$PORT"

        local ts_ip
        ts_ip=$(get_tailscale_ip)
        if [[ -n "$ts_ip" ]]; then
            echo "  Tailscale: http://$ts_ip:$PORT"
        fi

        echo "  Logs:      $LOG_FILE"
        echo "  Install:   $REPO_DIR"
    else
        echo -e "  Status:    ${RED}Stopped${NC}"

        if [[ -d "$REPO_DIR" ]]; then
            echo "  Install:   $REPO_DIR"
            echo ""
            echo "  Run 'stoa start' to start the server"
        else
            echo "  Install:   Not installed"
            echo ""
            echo "  Run 'stoa install' to install"
        fi
    fi
    echo ""
}

cmd_logs() {
    if [[ ! -f "$LOG_FILE" ]]; then
        log_warn "No log file found"
        exit 1
    fi

    tail -f "$LOG_FILE"
}

# Restore the previous source after a failed update: return to the original
# branch and reset it to <before>. Only reset if the checkout succeeds, so a
# deleted/renamed branch can't leave us resetting `main` to a non-main commit
# (which would brick future ff-only pulls). Handles a detached HEAD too.
restore_previous() {
    local ob="$1" bf="$2"
    if [[ -n "$ob" && "$ob" != "HEAD" ]]; then
        if git checkout "$ob" 2>/dev/null; then
            git reset --hard "$bf" 2>/dev/null || true
        else
            log_warn "Could not restore branch '$ob'; left HEAD as-is (avoided moving main)."
        fi
    else
        git checkout --detach "$bf" 2>/dev/null || true
    fi
}

cmd_update() {
    if [[ ! -d "$REPO_DIR" ]]; then
        log_error "Stoa is not installed. Run 'stoa install' first."
        exit 1
    fi

    cd "$REPO_DIR"

    # npm-global installs aren't git checkouts — they can't self-update via git.
    # Use -e (not -d): in a git worktree, .git is a FILE, not a directory.
    if [[ ! -e .git ]]; then
        log_error "This install isn't a git checkout, so it can't update via git."
        echo "  Update the npm package instead:"
        echo "    npm install -g @johnisag/stoa@latest"
        exit 1
    fi

    # Next.js rewrites next-env.d.ts on every build, so the tree is perpetually
    # "dirty" there even when untouched. Quietly discard such autogenerated files
    # (the rebuild regenerates them) so a routine update never demands a stash.
    # Genuine local edits are still protected by the check below.
    git checkout -- next-env.d.ts 2>/dev/null || true

    # Don't clobber genuine uncommitted local changes with a checkout/pull — but
    # only TRACKED edits block; untracked artifacts (a stray log/scratch file) are
    # safe across a ff-only pull, matching the Node CLI's blockingDirty.
    local dirty
    dirty=$(git status --porcelain | grep -v '^??' || true)
    if [[ -n "$dirty" ]]; then
        log_error "You have uncommitted local changes in $REPO_DIR."
        echo "  Those look like real edits, so the update won't touch them."
        echo "  Commit them (or 'git stash'), then re-run 'stoa update'."
        exit 1
    fi

    # Supervisor guard: not pid-tracked but the port is served -> an external
    # supervisor (or 'stoa run') is live; rebuilding .next under it would serve a
    # half-built app. Refuse (stop it first), matching the Node CLI.
    if ! is_running && port_in_use "$PORT"; then
        log_error "Port $PORT is in use but not by a 'stoa start' server."
        echo "  A supervisor (or 'stoa run') is serving this install. Stop it first,"
        echo "  then re-run 'stoa update' (and restart the supervisor)."
        exit 1
    fi

    local was_running=false
    if is_running; then
        was_running=true
        cmd_stop
    fi

    log_info "Updating from $(git remote get-url origin 2>/dev/null || echo origin)"
    local before after orig_branch
    before=$(git rev-parse --short HEAD)
    # Branch we start on (usually main; could be a feature branch or "HEAD"). On
    # failure we return here before resetting so we never force-move main.
    orig_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

    # Run the risky steps without set -e so a failure restarts the existing
    # version instead of aborting with the server left down.
    set +e
    # Pin to main so an install left on a (now-deleted) feature branch still updates.
    git fetch origin --tags && git checkout main && git pull --ff-only origin main
    local pull_rc=$?
    set -e
    if [[ $pull_rc -ne 0 ]]; then
        log_error "Update failed (git pull — local main may have diverged). Restoring..."
        restore_previous "$orig_branch" "$before"
        if [[ "$was_running" == true ]]; then
            log_warn "Restarting the server with the existing version..."
            cmd_start
        fi
        exit 1
    fi

    after=$(git rev-parse --short HEAD)
    if [[ "$before" == "$after" ]]; then
        log_success "Already up to date ($after)"
    else
        log_info "Updated $before -> $after"
        set +e
        npm install --include=dev --legacy-peer-deps && npm run build
        local build_rc=$?
        set -e
        if [[ $build_rc -ne 0 ]]; then
            log_error "Update failed (dependency install/build). Restoring previous version..."
            restore_previous "$orig_branch" "$before"
            if [[ "$was_running" == true ]]; then
                log_warn "Restarting the server with the existing version..."
                cmd_start
            fi
            exit 1
        fi
        # Guard a build that exited 0 but left an incomplete .next (interrupted/OOM):
        # don't restart into a partial build — it crash-loops.
        if [[ ! -f .next/prerender-manifest.json || ! -f .next/BUILD_ID ]]; then
            log_error "Build incomplete — .next is missing required files. Not restarting."
            echo "  Fix: cd \"$REPO_DIR\" && npm run build, then 'stoa start'."
            exit 1
        fi
        log_success "Update complete!"
    fi

    if [[ "$was_running" == true ]]; then
        cmd_start
    fi
}

cmd_enable() {
    if [[ ! -d "$REPO_DIR" ]]; then
        log_error "Stoa is not installed. Run 'stoa install' first."
        exit 1
    fi

    local script_path
    script_path=$(realpath "$0")

    if [[ "$OS" == "macos" ]]; then
        local plist_path="$HOME/Library/LaunchAgents/com.stoa.plist"

        cat > "$plist_path" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.stoa</string>
    <key>ProgramArguments</key>
    <array>
        <string>$script_path</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>$LOG_FILE</string>
    <key>StandardErrorPath</key>
    <string>$LOG_FILE</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF

        launchctl load "$plist_path" 2>/dev/null || true
        log_success "Auto-start enabled (launchd)"
        echo "  Plist: $plist_path"

    elif [[ -d /etc/systemd ]]; then
        local service_dir="$HOME/.config/systemd/user"
        local service_path="$service_dir/stoa.service"

        mkdir -p "$service_dir"

        cat > "$service_path" << EOF
[Unit]
Description=Stoa - AI Coding Session Manager
After=network.target

[Service]
Type=simple
ExecStart=$script_path start-foreground
Restart=on-failure
RestartSec=10
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

        systemctl --user daemon-reload
        systemctl --user enable stoa
        log_success "Auto-start enabled (systemd)"
        echo "  Service: $service_path"

    else
        log_error "Could not detect init system (launchd/systemd)"
        exit 1
    fi
}

cmd_disable() {
    if [[ "$OS" == "macos" ]]; then
        local plist_path="$HOME/Library/LaunchAgents/com.stoa.plist"

        if [[ -f "$plist_path" ]]; then
            launchctl unload "$plist_path" 2>/dev/null || true
            rm -f "$plist_path"
            log_success "Auto-start disabled"
        else
            log_warn "Auto-start was not enabled"
        fi

    elif [[ -d /etc/systemd ]]; then
        systemctl --user disable stoa 2>/dev/null || true
        rm -f "$HOME/.config/systemd/user/stoa.service"
        systemctl --user daemon-reload
        log_success "Auto-start disabled"

    else
        log_error "Could not detect init system"
        exit 1
    fi
}

cmd_uninstall() {
    echo ""
    log_warn "This will remove Stoa and all its data."

    if ! prompt_yn "Are you sure?" "n"; then
        log_info "Cancelled"
        exit 0
    fi

    # Detect if installed via npm (check if script is in node_modules)
    local installed_via_npm=false
    if [[ "$SCRIPT_DIR" == *"node_modules"* ]]; then
        installed_via_npm=true
    fi

    # Stop if running
    if is_running; then
        cmd_stop
    fi

    # Disable auto-start
    cmd_disable 2>/dev/null || true

    # Remove CLI symlink (only for non-npm installs)
    if [[ "$installed_via_npm" == false ]]; then
        if [[ -L "$HOME/.local/bin/stoa" ]]; then
            log_info "Removing CLI symlink..."
            rm -f "$HOME/.local/bin/stoa"
        elif [[ -L "/usr/local/bin/stoa" ]]; then
            # Legacy location
            log_info "Removing CLI symlink..."
            sudo rm -f "/usr/local/bin/stoa"
        fi
    fi

    # Remove installation directory
    if [[ -d "$STOA_HOME" ]]; then
        log_info "Removing $STOA_HOME..."
        rm -rf "$STOA_HOME"
    fi

    log_success "Stoa uninstalled"

    # If installed via npm, provide instructions to remove the global package
    if [[ "$installed_via_npm" == true ]]; then
        echo ""
        log_info "To completely remove the CLI, run:"
        echo "  npm uninstall -g @johnisag/stoa"
    fi
}

cmd_start_foreground() {
    if [[ ! -d "$REPO_DIR" ]]; then
        log_error "Stoa is not installed."
        exit 1
    fi

    cd "$REPO_DIR"

    # Create PID file before exec (PID stays the same after exec)
    echo "$$" > "$PID_FILE"

    exec npm start
}

cmd_help() {
    echo ""
    echo -e "${BOLD}Stoa${NC} - Self-hosted AI coding session manager"
    echo ""
    echo "Usage: stoa <command>"
    echo ""
    echo "Commands:"
    echo "  install     Install Stoa (auto-installs dependencies)"
    echo "  run         Start server and open in browser"
    echo "  start       Start the server in background"
    echo "  stop        Stop the server"
    echo "  restart     Restart the server"
    echo "  status      Show server status and URLs"
    echo "  logs        Tail server logs"
    echo "  update      Update to latest version"
    echo "  enable      Enable auto-start on boot"
    echo "  disable     Disable auto-start"
    echo "  uninstall   Remove Stoa completely"
    echo ""
    echo "Environment variables:"
    echo "  STOA_HOME   Installation directory (default: ~/.stoa)"
    echo "  STOA_PORT   Server port (default: 3011)"
    echo ""
}
