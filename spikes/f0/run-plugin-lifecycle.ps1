$ErrorActionPreference = "Stop"

$f0Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$marketplaceRoot = Join-Path $f0Root "copilot-marketplace"
$copilotHome = Join-Path (
    [IO.Path]::GetTempPath()
) "provenloop-copilot-home-$([Guid]::NewGuid().ToString('N'))"
$previousCopilotHome = $env:COPILOT_HOME

New-Item -ItemType Directory -Path $copilotHome | Out-Null

try {
    $env:COPILOT_HOME = $copilotHome

    copilot plugin marketplace add $marketplaceRoot | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Marketplace registration failed."
    }

    copilot plugin install provenloop-f0-probe@provenloop-f0 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Plugin installation failed."
    }

    copilot plugin install provenloop-f0-probe@provenloop-f0 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Idempotent plugin reinstallation failed."
    }

    copilot plugins disable provenloop-f0-probe@provenloop-f0 --plugin |
        Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Plugin disable failed."
    }
    $disabledList = copilot plugins list 2>&1 | Out-String

    copilot plugins enable provenloop-f0-probe@provenloop-f0 --plugin |
        Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Plugin enable failed."
    }
    $enabledList = copilot plugins list 2>&1 | Out-String

    $updateOutput = copilot plugin update provenloop-f0-probe@provenloop-f0 |
        Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "Plugin update command failed."
    }

    copilot plugin uninstall provenloop-f0-probe@provenloop-f0 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Plugin uninstall failed."
    }
    $afterUninstall = copilot plugins list 2>&1 | Out-String

    copilot plugin marketplace remove provenloop-f0 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Marketplace removal failed."
    }
    $afterMarketplaceRemoval = copilot plugins list 2>&1 | Out-String

    $result = [ordered]@{
        reinstallPassed = $true
        disabled = $disabledList -match "✗\s+provenloop-f0-probe"
        enabled = $enabledList -match "✓\s+provenloop-f0-probe"
        localMarketplaceUpdateIsLive = $updateOutput -match "always loaded live"
        uninstallDisablesLocalSource = (
            $afterUninstall -match "✗\s+provenloop-f0-probe"
        )
        absentAfterMarketplaceRemoval = (
            $afterMarketplaceRemoval -notmatch "provenloop-f0-probe"
        )
    }

    if (
        -not $result.reinstallPassed -or
        -not $result.disabled -or
        -not $result.enabled -or
        -not $result.localMarketplaceUpdateIsLive -or
        -not $result.uninstallDisablesLocalSource -or
        -not $result.absentAfterMarketplaceRemoval
    ) {
        throw "Plugin lifecycle checks failed: $(
            $result | ConvertTo-Json -Compress
        )"
    }

    $result | ConvertTo-Json
} finally {
    $env:COPILOT_HOME = $previousCopilotHome

    if (Test-Path $copilotHome) {
        Remove-Item -LiteralPath $copilotHome -Recurse -Force
    }
}
