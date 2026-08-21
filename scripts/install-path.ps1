function Normalize-WindowsPathEntry {
    param(
        [AllowNull()]
        [string]$Entry
    )

    if ([string]::IsNullOrWhiteSpace($Entry)) {
        return ""
    }

    return $Entry.Trim().TrimEnd([char]92, [char]47)
}

function Add-NpmGlobalBinToUserPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$NpmGlobalBin,

        [scriptblock]$TestDirectory = {
            param([string]$Path)
            Test-Path -LiteralPath $Path -PathType Container
        },

        [scriptblock]$ReadUserPath = {
            [Environment]::GetEnvironmentVariable("Path", "User")
        },

        [scriptblock]$WriteUserPath = {
            param([string]$Path)
            [Environment]::SetEnvironmentVariable("Path", $Path, "User")
        },

        [scriptblock]$ReadProcessPath = {
            $env:Path
        },

        [scriptblock]$WriteProcessPath = {
            param([string]$Path)
            $env:Path = $Path
        }
    )

    $trimmedBin = $NpmGlobalBin.Trim()
    if (-not (& $TestDirectory $trimmedBin)) {
        throw "npm global prefix does not exist: $trimmedBin"
    }

    $normalizedBin = Normalize-WindowsPathEntry $trimmedBin
    $userPath = [string](& $ReadUserPath)
    $userEntries = if ([string]::IsNullOrWhiteSpace($userPath)) {
        @()
    } else {
        @($userPath -split ";")
    }

    $userHasBin = $false
    foreach ($entry in $userEntries) {
        if ((Normalize-WindowsPathEntry $entry) -ieq $normalizedBin) {
            $userHasBin = $true
            break
        }
    }

    $userPathChanged = $false
    if (-not $userHasBin) {
        $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) {
            $trimmedBin
        } else {
            "$userPath;$trimmedBin"
        }

        # This is deliberately the User scope: never mutate the machine PATH.
        & $WriteUserPath $newUserPath
        $userPathChanged = $true
    }

    $processPath = [string](& $ReadProcessPath)
    $processEntries = if ([string]::IsNullOrWhiteSpace($processPath)) {
        @()
    } else {
        @($processPath -split ";")
    }

    $processHasBin = $false
    foreach ($entry in $processEntries) {
        if ((Normalize-WindowsPathEntry $entry) -ieq $normalizedBin) {
            $processHasBin = $true
            break
        }
    }

    $processPathChanged = $false
    $processPathRefreshFailed = $false
    if (-not $processHasBin) {
        $newProcessPath = if ([string]::IsNullOrWhiteSpace($processPath)) {
            $trimmedBin
        } else {
            "$trimmedBin;$processPath"
        }

        try {
            & $WriteProcessPath $newProcessPath
            $processPathChanged = $true
        } catch {
            # The User PATH is already repaired. A new shell will still inherit it.
            $processPathRefreshFailed = $true
        }
    }

    return [pscustomobject]@{
        NpmGlobalBin = $trimmedBin
        UserPathChanged = $userPathChanged
        ProcessPathChanged = $processPathChanged
        ProcessPathRefreshFailed = $processPathRefreshFailed
    }
}

function Add-DesktopCliPath {
    <#
    Desktop-only transactional wrapper. The npm installer intentionally keeps
    its historical process-refresh behaviour; the Squirrel lifecycle cannot
    leave a half-repaired user PATH behind when its short-lived helper fails.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [ValidateNotNullOrEmpty()] [string]$BinDir,
        [scriptblock]$ReadMachinePath = { [Environment]::GetEnvironmentVariable("Path", "Machine") },
        [scriptblock]$ReadUserPath = { [Environment]::GetEnvironmentVariable("Path", "User") },
        [scriptblock]$WriteUserPath = { param([string]$Path) [Environment]::SetEnvironmentVariable("Path", $Path, "User") },
        [scriptblock]$ReadProcessPath = { $env:Path },
        [scriptblock]$WriteProcessPath = { param([string]$Path) $env:Path = $Path },
        [string[]]$ResolvedOcxPaths = @(),
        [switch]$ForceFailure
    )

    $beforeUser = [string](& $ReadUserPath)
    $beforeProcess = [string](& $ReadProcessPath)
    $recovered = $false
    try {
        $repair = Add-NpmGlobalBinToUserPath -NpmGlobalBin $BinDir -TestDirectory { $true } -ReadUserPath $ReadUserPath -WriteUserPath $WriteUserPath -ReadProcessPath $ReadProcessPath -WriteProcessPath $WriteProcessPath
        if ($repair.ProcessPathRefreshFailed) {
            throw "the process PATH could not be refreshed"
        }
        if ($ForceFailure) {
            throw "forced desktop PATH transaction failure"
        }
        $machineValue = & $ReadMachinePath
        $userValue = & $ReadUserPath
        $freshShellPath = @($machineValue, $userValue) -join ";"
        $resolved = if ($ResolvedOcxPaths -and $ResolvedOcxPaths.Count -gt 0) { $ResolvedOcxPaths } else { Get-OcxCommandPaths -PathValue $freshShellPath }
        $collision = Resolve-OcxPathCollision -NpmGlobalBin $BinDir -ResolvedOcxPaths $resolved -ReadMachinePath $ReadMachinePath -ReadUserPath $ReadUserPath -WriteUserPath $WriteUserPath -ReadProcessPath $ReadProcessPath -WriteProcessPath $WriteProcessPath
        return [pscustomobject]@{
            Ok = $true
            UserPathChanged = $repair.UserPathChanged
            ProcessPathChanged = $repair.ProcessPathChanged
            Collision = $collision.Collision
            Winner = $collision.Winner
            Reordered = $collision.Reordered
            MachineBlocked = $collision.MachineBlocked
            TransactionRecovered = $false
        }
    } catch {
        try {
            & $WriteUserPath $beforeUser
            & $WriteProcessPath $beforeProcess
            $recovered = $true
        } catch {
            $recovered = $false
        }
        return [pscustomobject]@{
            Ok = $false
            Reason = $_.Exception.Message
            TransactionRecovered = $recovered
        }
    }
}

function Remove-OcxPathRegistration {
    <#
    Remove only a registration proven to belong to this build. The exact shim
    bytes are the ownership marker; a missing or edited shim is never a target.
    PATH changes and empty-directory removal are one transaction. The shim is
    first atomically claimed into a unique quarantine path, then its claimed
    bytes are inspected. An unowned claim is atomically restored when possible;
    a concurrent replacement is preserved and the quarantine is reported.
    No recursive deletion is used.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [ValidateNotNullOrEmpty()] [string]$BinDir,
        [Parameter(Mandatory)] [ValidateNotNullOrEmpty()] [string]$ShimPath,
        [Parameter(Mandatory)] [AllowEmptyString()] [string]$ExpectedShimContent,
        [scriptblock]$ReadUserPath = { [Environment]::GetEnvironmentVariable("Path", "User") },
        [scriptblock]$WriteUserPath = { param([string]$Path) [Environment]::SetEnvironmentVariable("Path", $Path, "User") },
        [scriptblock]$ReadProcessPath = { $env:Path },
        [scriptblock]$WriteProcessPath = { param([string]$Path) $env:Path = $Path },
        [scriptblock]$ReadShim = { if (Test-Path -LiteralPath $ShimPath -PathType Leaf) { [pscustomobject]@{ Exists = $true; Content = [IO.File]::ReadAllText($ShimPath) } } else { [pscustomobject]@{ Exists = $false; Content = $null } } },
        [scriptblock]$NewClaimPath = { param([string]$Path) "$Path.ocx-claim-$([guid]::NewGuid().ToString('N')).tmp" },
        [scriptblock]$ClaimShim = { param([string]$ClaimPath) Move-Item -LiteralPath $ShimPath -Destination $ClaimPath -Force },
        [scriptblock]$ReadClaim = { param([string]$ClaimPath) [IO.File]::ReadAllText($ClaimPath) },
        [scriptblock]$RestoreClaim = { param([string]$ClaimPath) Move-Item -LiteralPath $ClaimPath -Destination $ShimPath -Force },
        [scriptblock]$RemoveClaim = { param([string]$ClaimPath) Remove-Item -LiteralPath $ClaimPath -Force },
        [scriptblock]$TestShim = { Test-Path -LiteralPath $ShimPath -PathType Leaf },
        [scriptblock]$TestDirectory = { Test-Path -LiteralPath $BinDir -PathType Container },
        [scriptblock]$GetDirectoryEntries = { Get-ChildItem -LiteralPath $BinDir -Force },
        [scriptblock]$RemoveDirectory = { Remove-Item -LiteralPath $BinDir -Force },
        [scriptblock]$CreateDirectory = { [IO.Directory]::CreateDirectory($BinDir) | Out-Null }
    )

    $shim = & $ReadShim
    if (-not $shim.Exists) {
        return [pscustomobject]@{ Ok = $true; Owned = $false; Removed = $false; Reason = "the stable ocx shim does not exist" }
    }

    $beforeUser = [string](& $ReadUserPath)
    $beforeProcess = [string](& $ReadProcessPath)
    $userChanged = $false
    $processChanged = $false
    $dirRemoved = $false
    $claimPath = $null
    $claimOwned = $false
    $claimRemoved = $false
    $replacementConflict = $false
    try {
        # Move-Item is a same-volume rename here: it claims the exact inode
        # before any byte inspection or PATH mutation, so a concurrent writer
        # cannot be mistaken for the file we just inspected.
        $claimPath = & $NewClaimPath $ShimPath
        & $ClaimShim $claimPath
        $claimedContent = [string](& $ReadClaim $claimPath)
        $claimOwned = $claimedContent -ceq $ExpectedShimContent
        if (-not $claimOwned) {
            if (-not (& $TestShim)) {
                & $RestoreClaim $claimPath
                $claimRemoved = $true
                return [pscustomobject]@{ Ok = $true; Owned = $false; Removed = $false; Reason = "the stable ocx shim is not owned by this install"; TransactionRecovered = $true; RollbackFailed = $false }
            }
            # A replacement appeared after the claim. Preserve the quarantine
            # and the replacement rather than overwriting either one.
            $replacementConflict = $true
            return [pscustomobject]@{ Ok = $false; Owned = $false; Removed = $false; Reason = "an unowned replacement ocx shim appeared during uninstall; quarantine preserved"; TransactionRecovered = $true; RollbackFailed = $false; ReplacementConflict = $true; ClaimPath = $claimPath }
        }

        $normalizedBin = Normalize-WindowsPathEntry $BinDir
        $userEntries = if ([string]::IsNullOrWhiteSpace($beforeUser)) { @() } else { @($beforeUser -split ";") }
        $newUserEntries = @($userEntries | Where-Object { (Normalize-WindowsPathEntry $_) -ine $normalizedBin })
        $newUser = $newUserEntries -join ";"
        if ($newUser -cne $beforeUser) {
            & $WriteUserPath $newUser
            $userChanged = $true
        }

        $processEntries = if ([string]::IsNullOrWhiteSpace($beforeProcess)) { @() } else { @($beforeProcess -split ";") }
        $newProcessEntries = @($processEntries | Where-Object { (Normalize-WindowsPathEntry $_) -ine $normalizedBin })
        $newProcess = $newProcessEntries -join ";"
        if ($newProcess -cne $beforeProcess) {
            & $WriteProcessPath $newProcess
            $processChanged = $true
        }

        # Never delete a replacement that appeared after the atomic claim.
        if (& $TestShim) {
            $replacementConflict = $true
            throw "a replacement ocx shim appeared during uninstall; quarantine preserved"
        }
        if (& $TestDirectory) {
            $children = @(& $GetDirectoryEntries)
            if ($children.Count -eq 0) {
                & $RemoveDirectory
                $dirRemoved = $true
            }
        }
        # Delete the claimed bytes only after every reversible directory step
        # has succeeded. If this final delete fails, the claim can still be
        # atomically restored to the stable path.
        & $RemoveClaim $claimPath
        $claimRemoved = $true
        return [pscustomobject]@{
            Ok = $true; Owned = $true; Removed = $true
            UserPathChanged = $userChanged; ProcessPathChanged = $processChanged; StableDirRemoved = $dirRemoved
            TransactionRecovered = $true; RollbackFailed = $false
        }
    } catch {
        $recovered = $true
        try {
            if ($userChanged) { & $WriteUserPath $beforeUser }
            if ($processChanged) { & $WriteProcessPath $beforeProcess }
            if (-not $claimRemoved -and $null -ne $claimPath) {
                if ($dirRemoved -and -not (& $TestShim)) { & $CreateDirectory }
                if (-not (& $TestShim)) { & $RestoreClaim $claimPath; $claimRemoved = $true }
            }
        } catch {
            $recovered = $false
        }
        return [pscustomobject]@{
            Ok = $false; Owned = $claimOwned; Removed = $false; Reason = $_.Exception.Message
            TransactionRecovered = $recovered; RollbackFailed = -not $recovered
            ReplacementConflict = $replacementConflict
            ClaimPath = if ($claimRemoved) { $null } else { $claimPath }
        }
    }
}

function Get-OcxCommandPaths {
    <#
    .SYNOPSIS
    Mirror what a fresh shell would resolve for `ocx`, in PATH order.

    .DESCRIPTION
    `Get-Command -All` is deliberately NOT used here: inside PowerShell it also
    matches functions, aliases and scripts named `ocx` that a plain cmd.exe
    shell, an npm script, or a CI runner would never invoke — which would
    report a "collision" that does not actually exist for anything other than
    this one interactive session. Walking PATH by hand and testing each
    directory for `ocx` plus the actual PATHEXT suffixes answers the
    question this script actually needs: which file does this fork's shim
    have to beat to be the one that runs.
    #>
    param(
        [AllowNull()]
        [string]$PathValue,
        [string]$PathextValue = $env:PATHEXT,
        [string[]]$Extensions,
        [scriptblock]$TestFile = {
            param([string]$Path)
            Test-Path -LiteralPath $Path -PathType Leaf
        }
    )

    $found = @()
    # The comma before $found on every `return` below is load-bearing, not
    # style: PowerShell unrolls a returned array of zero or one elements, so
    # `return $found` silently hands the caller $null (zero elements) or a
    # bare string (one element) instead of an array — and `$null.Count` reads
    # back as $null rather than 0, which would make the "nothing found" check
    # in Resolve-OcxPathCollision below misfire. `,$found` forces the array to
    # survive the return intact at every length.
    if ([string]::IsNullOrWhiteSpace($PathValue)) { return ,$found }
    if (-not $Extensions -or $Extensions.Count -eq 0) {
        $Extensions = @($PathextValue -split ";" | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
        if (-not $Extensions -or $Extensions.Count -eq 0) { $Extensions = @(".com", ".exe", ".bat", ".cmd") }
    }

    foreach ($dir in ($PathValue -split ";")) {
        $trimmed = $dir.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
        foreach ($ext in $Extensions) {
            $candidate = Join-Path $trimmed "ocx$ext"
            if (& $TestFile $candidate) {
                $found += $candidate
                break
            }
        }
    }
    return ,$found
}

function Resolve-OcxPathCollision {
    <#
    .SYNOPSIS
    Make sure THIS fork's `ocx` is the one a fresh shell actually runs, and say
    so either way.

    .DESCRIPTION
    Two installs can each register an `ocx` command — this fork's npm global
    install and, on the same machine, an unrelated one (an upstream
    `opencodex` checkout, a stale global install under a different npm
    prefix, a standalone installer). Whichever directory comes first on PATH
    wins silently, and a user who thinks they are running this fork's fixes
    could be running someone else's build with no indication anything is
    wrong.

    This never touches the machine-scope PATH and never asks for elevation:
    - If nothing else answers to `ocx`, or the first match already lives in
      our own npm global bin directory, there is nothing to do.
    - If another directory wins and it is NOT on the machine PATH, our
      directory is moved to the front of the user PATH (both the persisted
      User env var and this process's own $env:Path) so every new shell
      resolves to this fork from now on.
    - If the winning directory IS on the machine PATH, reordering the user
      PATH can never beat it — machine PATH always precedes user PATH in the
      combined environment — so this is reported honestly as a collision this
      script cannot fix, rather than silently doing nothing and calling it
      success.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$NpmGlobalBin,

        [string[]]$ResolvedOcxPaths = @(),

        [scriptblock]$ReadMachinePath = {
            [Environment]::GetEnvironmentVariable("Path", "Machine")
        },

        [scriptblock]$ReadUserPath = {
            [Environment]::GetEnvironmentVariable("Path", "User")
        },

        [scriptblock]$WriteUserPath = {
            param([string]$Path)
            [Environment]::SetEnvironmentVariable("Path", $Path, "User")
        },

        [scriptblock]$ReadProcessPath = {
            $env:Path
        },

        [scriptblock]$WriteProcessPath = {
            param([string]$Path)
            $env:Path = $Path
        }
    )

    $normalizedBin = Normalize-WindowsPathEntry $NpmGlobalBin

    if (-not $ResolvedOcxPaths -or $ResolvedOcxPaths.Count -eq 0) {
        return [pscustomobject]@{
            Collision = $false
            Winner = $null
            Reordered = $false
            MachineBlocked = $false
        }
    }

    $winner = $ResolvedOcxPaths[0]
    $winnerDir = Normalize-WindowsPathEntry (Split-Path -Parent $winner)

    if ($winnerDir -ieq $normalizedBin) {
        return [pscustomobject]@{
            Collision = $false
            Winner = $winner
            Reordered = $false
            MachineBlocked = $false
        }
    }

    $machinePath = [string](& $ReadMachinePath)
    $machineEntries = if ([string]::IsNullOrWhiteSpace($machinePath)) {
        @()
    } else {
        @($machinePath -split ";" | ForEach-Object { Normalize-WindowsPathEntry $_ })
    }
    $machineBlocked = @($machineEntries | Where-Object { $_ -ieq $winnerDir }).Count -gt 0

    if ($machineBlocked) {
        return [pscustomobject]@{
            Collision = $true
            Winner = $winner
            Reordered = $false
            MachineBlocked = $true
        }
    }

    # Reorder: our directory first, then every existing user PATH entry that
    # is not already us (drop a stray duplicate rather than doubling it).
    $userPath = [string](& $ReadUserPath)
    $userEntries = if ([string]::IsNullOrWhiteSpace($userPath)) { @() } else { @($userPath -split ";") }
    $userRest = @($userEntries | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_) -and (Normalize-WindowsPathEntry $_) -ine $normalizedBin
    })
    $newUserPath = (@($NpmGlobalBin) + $userRest) -join ";"
    & $WriteUserPath $newUserPath

    $processPath = [string](& $ReadProcessPath)
    $processEntries = if ([string]::IsNullOrWhiteSpace($processPath)) { @() } else { @($processPath -split ";") }
    $processRest = @($processEntries | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_) -and (Normalize-WindowsPathEntry $_) -ine $normalizedBin
    })
    $newProcessPath = (@($NpmGlobalBin) + $processRest) -join ";"
    & $WriteProcessPath $newProcessPath

    return [pscustomobject]@{
        Collision = $true
        Winner = $winner
        Reordered = $true
        MachineBlocked = $false
    }
}
