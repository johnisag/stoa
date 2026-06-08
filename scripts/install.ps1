<#
.SYNOPSIS
    Stoa installer for native Windows.

.DESCRIPTION
    Mirrors scripts/install.sh for Windows / PowerShell. Checks prerequisites
    (Node 24+, Git), clones or updates the repo into %USERPROFILE%\.stoa\repo,
    installs npm dependencies, builds for production, and prints how to start.

    Designed to be run via:
        irm https://raw.githubusercontent.com/johnisag/stoa/main/scripts/install.ps1 | iex

.NOTES
    PowerShell 5.1 compatible: no `&&`/`||` chaining; uses `if ($?) {}` instead.
    Does NOT install tmux (removed) or ripgrep (bundled via @vscode/ripgrep).
#>

# Stop on the first unhandled error so a failed step doesn't cascade silently.
$ErrorActionPreference = "Stop"

$RepoUrl    = "https://github.com/johnisag/stoa.git"
$AgentHome  = Join-Path $env:USERPROFILE ".stoa"
$InstallDir = Join-Path $AgentHome "repo"

function Write-Info    { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok      { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Green }
function Write-Err     { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Red }

Write-Host ""
Write-Host "Stoa Installer" -ForegroundColor White
Write-Host ""

# ---------------------------------------------------------------------------
# Prerequisite: Node.js 24+
# ---------------------------------------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Err "Node.js is required but was not found."
    Write-Host "    Install it with:  winget install OpenJS.NodeJS.LTS"
    Write-Host "    Then re-open your terminal and run this installer again."
    exit 1
}

# `node -v` prints e.g. "v24.0.0"; strip the leading "v" and take the major.
$nodeVersionRaw = (& node -v).Trim()
$nodeMajor = [int]($nodeVersionRaw.TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 24) {
    Write-Err "Node.js 24+ is required (found $nodeVersionRaw)."
    Write-Host "    Upgrade with:  winget install OpenJS.NodeJS.LTS"
    exit 1
}
Write-Info "Node.js: $nodeVersionRaw"

# ---------------------------------------------------------------------------
# Prerequisite: Git
# ---------------------------------------------------------------------------
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Err "Git is required but was not found."
    Write-Host "    Install it with:  winget install Git.Git"
    Write-Host "    Then re-open your terminal and run this installer again."
    exit 1
}
Write-Info "Git: $((& git --version).Trim())"

# ---------------------------------------------------------------------------
# Clone or update the repository (idempotent)
# ---------------------------------------------------------------------------
if (Test-Path $InstallDir) {
    Write-Info "Updating existing installation..."
    Push-Location $InstallDir
    # Match the `stoa update` path: fetch + pin to main, so an install left on a
    # (now-deleted) feature branch still updates cleanly.
    & git fetch origin --tags
    if (-not $?) { Pop-Location; Write-Err "git fetch failed."; exit 1 }
    & git checkout main
    if (-not $?) { Pop-Location; Write-Err "git checkout main failed."; exit 1 }
    & git pull --ff-only origin main
    if (-not $?) { Pop-Location; Write-Err "git pull failed."; exit 1 }
    Pop-Location
} else {
    Write-Info "Downloading Stoa..."
    if (-not (Test-Path $AgentHome)) {
        New-Item -ItemType Directory -Force -Path $AgentHome | Out-Null
    }
    & git clone $RepoUrl $InstallDir
    if (-not $?) { Write-Err "git clone failed."; exit 1 }
}

# ---------------------------------------------------------------------------
# Install dependencies and build for production
# ---------------------------------------------------------------------------
Push-Location $InstallDir

Write-Info "Installing dependencies..."
# --include=dev: the build needs devDeps (next/tailwind/typescript); a shell with
# NODE_ENV=production would otherwise omit them and break `npm run build`.
& npm install --include=dev --legacy-peer-deps
if (-not $?) { Pop-Location; Write-Err "npm install failed."; exit 1 }

Write-Info "Building for production..."
& npm run build
if (-not $?) { Pop-Location; Write-Err "npm run build failed."; exit 1 }

# An interrupted build can exit 0 yet leave an incomplete .next (missing
# prerender-manifest.json), which crash-loops the server. Verify the artifact.
if (-not (Test-Path (Join-Path $InstallDir ".next\prerender-manifest.json"))) {
    Pop-Location
    Write-Err "Build incomplete (.next is missing required files). Re-run: npm run build"
    exit 1
}

Pop-Location

# ---------------------------------------------------------------------------
# Put `stoa` on PATH (best-effort) so `stoa start/status/update` work anywhere.
# Without this the advertised `stoa` command is "not recognized" after install.
# ---------------------------------------------------------------------------
Push-Location $InstallDir
Write-Info "Attempting to link the 'stoa' command to your PATH (best-effort)..."
& npm link
$linked = $?
Pop-Location

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Ok "Stoa installed successfully!"
Write-Host ""
Write-Host "Installed at: $InstallDir"
Write-Host ""
if ($linked) {
    Write-Host "Next steps:"
    Write-Host "  stoa start"
    Write-Host ""
    Write-Host "If PowerShell blocks 'stoa' (script execution disabled), run once:"
    Write-Host "  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned"
} else {
    Write-Err "Could not link 'stoa' to your PATH automatically."
    Write-Host "  (npm link needs symlink permission - enable Settings / Privacy and security /"
    Write-Host "   For developers / Developer Mode, or re-run this installer as Administrator.)"
    Write-Host "Run it directly instead:"
    Write-Host "  node `"$InstallDir\scripts\stoa.js`" start"
    Write-Host "  - or -"
    Write-Host "  cd `"$InstallDir`"; npm start"
}
Write-Host ""
Write-Host "Then open http://localhost:3011 in your browser."
Write-Host ""
