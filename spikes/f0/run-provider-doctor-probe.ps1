param(
    [Parameter(Mandatory)]
    [ValidateSet(
        "available",
        "signed_out",
        "rate_limited",
        "incompatible",
        "unavailable"
    )]
    [string]$ExpectedStatus,
    [string]$CopilotHome,
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
    ) "evaluation\m0-probes\provider-$ExpectedStatus.json"
}

$previousCopilotHome = $env:COPILOT_HOME
try {
    if ($CopilotHome) {
        $env:COPILOT_HOME = $CopilotHome
    }
    $json = & provenloop doctor --online --data-root $DataRoot
    if ($LASTEXITCODE -gt 1) {
        throw "Online Doctor encountered an infrastructure failure."
    }
    $doctor = $json | ConvertFrom-Json
    $actual = [string]$doctor.providerStatus
    $report = [ordered]@{
        schemaVersion = 1
        probeVersion = 1
        capturedAt = [DateTimeOffset]::UtcNow.ToString("o")
        expectedStatus = $ExpectedStatus
        actualStatus = $actual
        matched = $actual -eq $ExpectedStatus
        status = if ($actual -eq $ExpectedStatus) {
            "pass"
        } else {
            "fail"
        }
    }
    $directory = Split-Path -Parent $OutputPath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $report | ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath $OutputPath -Encoding utf8
    $report | ConvertTo-Json -Depth 4
    if (-not $report.matched) {
        exit 1
    }
} finally {
    $env:COPILOT_HOME = $previousCopilotHome
}
