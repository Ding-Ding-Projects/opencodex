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
