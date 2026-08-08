#Requires -Version 5.1
$ErrorActionPreference = "Stop"

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

function Add-PathEntry {
    param(
        [AllowEmptyString()]
        [string]$PathValue,
        [Parameter(Mandatory = $true)]
        [string]$Entry
    )

    $existingPath = if ($null -eq $PathValue) { "" } else { $PathValue }
    $normalizedEntry = $Entry.TrimEnd("\")
    $alreadyPresent = @($existingPath -split ";" |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Where-Object { $_.Trim().TrimEnd("\") -ieq $normalizedEntry } |
        Select-Object -First 1)
    if ($alreadyPresent.Count -gt 0) {
        return $existingPath
    }

    if ([string]::IsNullOrEmpty($existingPath)) {
        return $Entry
    }
    if ($existingPath.EndsWith(";")) {
        return "$existingPath$Entry"
    }
    return "$existingPath;$Entry"
}

function Add-NpmGlobalBinToPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$NpmSource
    )

    # On Windows npm's global bin directory is the global prefix itself.
    $prefixOutput = (& $NpmSource prefix -g 2>&1 | Out-String).Trim()
    $prefixExitCode = $LASTEXITCODE
    if ($prefixExitCode -ne 0) {
        throw "npm prefix -g failed with exit code $prefixExitCode."
    }
    if ([string]::IsNullOrWhiteSpace($prefixOutput)) {
        throw "npm prefix -g returned an empty global bin directory."
    }
    if ($prefixOutput -match "[`r`n]") {
        throw "npm prefix -g returned more than one line, so its global bin directory is invalid."
    }
    if (-not [System.IO.Path]::IsPathRooted($prefixOutput)) {
        throw "npm prefix -g returned a non-absolute global bin directory '$prefixOutput'."
    }

    try {
        $npmPrefix = [System.IO.Path]::GetFullPath($prefixOutput)
    } catch {
        throw "npm prefix -g returned an invalid global bin directory '$prefixOutput'."
    }
    if (-not [System.IO.Path]::IsPathRooted($npmPrefix) -or
        $npmPrefix -eq [System.IO.Path]::GetPathRoot($npmPrefix) -or
        -not (Test-Path -LiteralPath $npmPrefix -PathType Container)) {
        throw "npm prefix -g returned an invalid or missing global bin directory '$prefixOutput'."
    }

    try {
        $userPath = [Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::User)
        $updatedUserPath = Add-PathEntry -PathValue $userPath -Entry $npmPrefix
        if ($updatedUserPath -cne $userPath) {
            [Environment]::SetEnvironmentVariable("Path", $updatedUserPath, [System.EnvironmentVariableTarget]::User)
        }

        # A child PowerShell cannot change its parent's environment, but this
        # installer must resolve the new command in the process running now.
        $env:Path = Add-PathEntry -PathValue $env:Path -Entry $npmPrefix
    } catch {
        throw "could not write the current user's PATH or update this process: $($_.Exception.Message)"
    }

    return $npmPrefix
}

$ocx = Get-Command ocx.cmd -ErrorAction SilentlyContinue
if (-not $ocx) {
    $ocx = Get-Command ocx -ErrorAction SilentlyContinue
}
if (-not $ocx) {
    try {
        $npmPrefix = Add-NpmGlobalBinToPath -NpmSource $npm.Source
    } catch {
        Write-Error "opencodex installed, but 'ocx' is not resolvable and its npm global bin directory could not be added to PATH: $($_.Exception.Message)"
        exit 1
    }

    $ocx = Get-Command ocx.cmd -ErrorAction SilentlyContinue
    if (-not $ocx) {
        $ocx = Get-Command ocx -ErrorAction SilentlyContinue
    }
    if (-not $ocx) {
        Write-Error "opencodex installed, but 'ocx.cmd'/'ocx' could not be resolved after adding npm's global bin directory '$npmPrefix' to the current user's PATH."
        exit 1
    }
}

& $ocx.Source help *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error "opencodex installed, but 'ocx.cmd help' failed with exit code $LASTEXITCODE. Check your npm global install and PATH."
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "opencodex installed! Run 'ocx init' to set up." -ForegroundColor Green
