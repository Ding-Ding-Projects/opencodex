#Requires -Version 5.1
<#
.SYNOPSIS
Desktop-app glue: make sure a given directory is what a fresh shell resolves
`ocx` to.

.DESCRIPTION
Invoked by electron/cli-path.mjs (via `powershell.exe -File`) during a
Squirrel `--squirrel-install` / `--squirrel-updated` event. The Electron main
process cannot itself write the user-scope PATH registry value the safe way —
Node has no equivalent of [Environment]::SetEnvironmentVariable, and shelling
out to `setx` risks silently truncating PATH past its 1024-character limit,
which is exactly the kind of damage this whole feature exists to avoid.

This reuses Add-NpmGlobalBinToUserPath / Resolve-OcxPathCollision /
Get-OcxCommandPaths from install-path.ps1 — the SAME functions
scripts/install.ps1 uses for the npm install path — so there is one tested
PATH-repair mechanism behind both installers instead of two that could drift
out of sync with each other.

Only ever touches the user-scope PATH. Never the machine PATH, never asks for
elevation, and a machine-scope collision it cannot fix is reported as such
rather than pretended away (see Resolve-OcxPathCollision's own docs).

.PARAMETER BinDir
The desktop app's own stable CLI shim directory (electron/cli-path.mjs's
`cli-bin` directory next to Update.exe — NOT the versioned app-x.y.z
directory, which Squirrel replaces wholesale on every update).

.OUTPUTS
Exactly one line of compact JSON on stdout describing what happened, and
nothing else, so the Node caller can parse stdout directly without scraping
human-readable text. On success:
  {"ok":true,"binDir":"...","userPathChanged":true,"collision":false,"collisionWinner":null,"collisionReordered":false,"collisionMachineBlocked":false}
On failure:
  {"ok":false,"binDir":"...","reason":"..."}
#>
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$BinDir,

    [ValidateSet("install", "uninstall")]
    [string]$Action = "install",

    [string]$ShimPath,

    [AllowEmptyString()]
    [string]$ExpectedShimContent
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptRoot "install-path.ps1")

try {
    if ($Action -eq "uninstall") {
        if ([string]::IsNullOrWhiteSpace($ShimPath)) { throw "ShimPath is required for uninstall" }
        $result = Remove-OcxPathRegistration -BinDir $BinDir -ShimPath $ShimPath -ExpectedShimContent $ExpectedShimContent
        $result | Add-Member -NotePropertyName ok -NotePropertyValue ([bool]$result.Ok) -Force
        $result | Add-Member -NotePropertyName binDir -NotePropertyValue $BinDir -Force
        $result | ConvertTo-Json -Compress
        exit 0
    }

    $repair = Add-DesktopCliPath -BinDir $BinDir
    if (-not $repair.Ok) {
        [pscustomobject]@{
            ok = $false
            binDir = $BinDir
            reason = $repair.Reason
            transactionRecovered = $repair.TransactionRecovered
        } | ConvertTo-Json -Compress
        exit 0
    }

    [pscustomobject]@{
        ok = $true
        binDir = $BinDir
        userPathChanged = $repair.UserPathChanged
        processPathChanged = $repair.ProcessPathChanged
        collision = $repair.Collision
        collisionWinner = $repair.Winner
        collisionReordered = $repair.Reordered
        collisionMachineBlocked = $repair.MachineBlocked
    } | ConvertTo-Json -Compress
} catch {
    [pscustomobject]@{
        ok = $false
        binDir = $BinDir
        reason = $_.Exception.Message
    } | ConvertTo-Json -Compress
}
