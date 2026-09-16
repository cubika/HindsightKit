$ErrorActionPreference = "Stop"

$f0Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$extensionProbe = Join-Path $f0Root "run-extension-probe.ps1"
$copilotHome = Join-Path (
    [IO.Path]::GetTempPath()
) "provenloop-extension-opt-in-$([Guid]::NewGuid().ToString('N'))"
$previousCopilotHome = $env:COPILOT_HOME

New-Item -ItemType Directory -Path $copilotHome | Out-Null

try {
    $env:COPILOT_HOME = $copilotHome

    @{ experimental = $true } |
        ConvertTo-Json |
        Set-Content -Encoding utf8 (Join-Path $copilotHome "settings.json")

    $enabledSettings = Get-Content (
        Join-Path $copilotHome "settings.json"
    ) -Raw | ConvertFrom-Json

    $probeOutput = & $extensionProbe `
        -Mode baseline `
        -OmitExperimentalFlag `
        -CopilotHome $copilotHome | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "The Extension did not load from persisted experimental settings."
    }
    $probeResult = $probeOutput | ConvertFrom-Json

    @{ experimental = $false } |
        ConvertTo-Json |
        Set-Content -Encoding utf8 (Join-Path $copilotHome "settings.json")

    $disabledSettings = Get-Content (
        Join-Path $copilotHome "settings.json"
    ) -Raw | ConvertFrom-Json
    $disabledProbeOutput = & $extensionProbe `
        -Mode baseline `
        -OmitExperimentalFlag `
        -ExpectExtensionDisabled `
        -CopilotHome $copilotHome | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "The disabled Extension probe failed."
    }
    $disabledProbeResult = $disabledProbeOutput | ConvertFrom-Json

    $result = [ordered]@{
        persistedEnabled = $enabledSettings.experimental -eq $true
        ordinaryLaunchLoadedExtension = (
            $probeResult.extensionStarted -and
            $probeResult.foregroundCompleted
        )
        persistedDisabled = $disabledSettings.experimental -eq $false
        ordinaryLaunchSkippedExtension = (
            -not $disabledProbeResult.extensionStarted -and
            $disabledProbeResult.foregroundCompleted
        )
    }

    if (
        -not $result.persistedEnabled -or
        -not $result.ordinaryLaunchLoadedExtension -or
        -not $result.persistedDisabled -or
        -not $result.ordinaryLaunchSkippedExtension
    ) {
        throw "Extension opt-in checks failed: $(
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
