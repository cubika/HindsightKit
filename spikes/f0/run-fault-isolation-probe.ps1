param(
    [string]$DataRoot,
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"

if (-not $DataRoot) {
    if (-not $env:LOCALAPPDATA) {
        throw "LOCALAPPDATA is required when -DataRoot is omitted."
    }
    $DataRoot = Join-Path $env:LOCALAPPDATA "ProvenLoop"
}
if (-not $OutputPath) {
    $OutputPath = Join-Path (
        $DataRoot
    ) "evaluation\m0-probes\fault-isolation-report.json"
}

$capabilityReportPath = Join-Path (
    Split-Path -Parent $OutputPath
) "capability-isolation-report.json"
& (Join-Path $PSScriptRoot "run-capability-isolation-probe.ps1") `
    -DataRoot $DataRoot `
    -OutputPath $capabilityReportPath | Out-Null
$capability = Get-Content -LiteralPath $capabilityReportPath -Raw |
    ConvertFrom-Json

$report = [ordered]@{
    schemaVersion = 1
    probeVersion = 1
    capturedAt = [DateTimeOffset]::UtcNow.ToString("o")
    capabilityIsolation = $capability.status
    workerStopped = $capability.workerDisabledPassed
    retrievalDisabled = $capability.retrievalDisabledPassed
    captureDisabled = $capability.captureDisabledPassed
    extensionTermination = "manual_required"
    queueWriteFailure = "manual_required"
    providerDegradation = "isolated_profile_required"
    status = "incomplete"
}

$directory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$report | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $OutputPath -Encoding utf8
$report | ConvertTo-Json -Depth 5
