#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptRoot "install-path.ps1")

Write-Host "Installing opencodex..." -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js 18+ is required. Install Node from https://nodejs.org/ and rerun this script."
    exit 1
}

$nodeVersion = & node -p "process.versions.node"
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 18) {
    Write-Error "Node.js 18+ is required. Current version: v$nodeVersion"
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm is required to install the published opencodex package."
    exit 1
}

Write-Host "Using Node v$nodeVersion"

# Install opencodex globally
# If npm reports "install scripts blocked" for bun, rerun as:
#   npm install -g --allow-scripts=bun @bitkyc08/opencodex
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    $npm = Get-Command npm -ErrorAction Stop
}
& $npm.Source install -g @bitkyc08/opencodex
if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

$npmPrefix = (& $npm.Source prefix -g).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($npmPrefix)) {
    Write-Error "opencodex installed, but npm could not report its global prefix. Run 'npm.cmd prefix -g' and add that directory to your user PATH."
    exit 1
}

try {
    $pathRepair = Add-NpmGlobalBinToUserPath -NpmGlobalBin $npmPrefix
} catch {
    Write-Error "opencodex installed, but the user PATH could not be updated for '$npmPrefix'. No machine PATH was changed. Add this directory to your user PATH, then reopen PowerShell: $($_.Exception.Message)"
    exit 1
}

$ocx = Get-Command ocx.cmd -ErrorAction SilentlyContinue
if (-not $ocx) {
    $ocx = Get-Command ocx -ErrorAction SilentlyContinue
}
if (-not $ocx) {
    if ($pathRepair.ProcessPathRefreshFailed) {
        Write-Error "opencodex installed and the user PATH includes '$npmPrefix', but this PowerShell process could not be refreshed. Open a new PowerShell window and run 'ocx help'."
    } else {
        Write-Error "opencodex installed and the user PATH includes '$npmPrefix', but 'ocx' is still unavailable in this PowerShell process. Open a new PowerShell window and run 'ocx help'."
    }
    exit 1
}

& $ocx.Source help *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error "opencodex installed, but 'ocx.cmd help' failed with exit code $LASTEXITCODE. Check your npm global install and PATH."
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "opencodex installed! Run 'ocx init' to set up." -ForegroundColor Green
