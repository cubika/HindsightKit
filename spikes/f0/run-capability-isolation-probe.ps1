param(
    [string]$DataRoot,
    [string]$OutputPath,
    [string]$AutomatedTestReport
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "report-digest.ps1")

if (-not $DataRoot) {
    if (-not $env:LOCALAPPDATA) {
        throw "LOCALAPPDATA is required when -DataRoot is omitted."
    }
    $DataRoot = Join-Path $env:LOCALAPPDATA "ProvenLoop"
}
if (-not $OutputPath) {
    $OutputPath = Join-Path (
        $DataRoot
    ) "evaluation\m0-probes\capability-isolation-report.json"
}

function Get-ProvenLoopStatus {
    $json = & provenloop status --data-root $DataRoot
    if ($LASTEXITCODE -ne 0) {
        throw "provenloop status failed."
    }
    $json | ConvertFrom-Json
}

function Get-CapabilityEnabled([object]$Status, [string]$Name) {
    [bool](
        $Status.capabilities.capabilities |
            Where-Object capability -EQ $Name |
            Select-Object -ExpandProperty enabled
    )
}

function Test-TestCount([object]$Value) {
    if (-not (
        $Value -is [int] -or $Value -is [long] -or
        $Value -is [double] -or $Value -is [decimal]
    )) {
        return $false
    }
    $number = [double]$Value
    return (
        -not [double]::IsNaN($number) -and
        -not [double]::IsInfinity($number) -and
        $number -ge 0 -and $number -eq [Math]::Truncate($number)
    )
}

$capabilities = @(
    "capture",
    "retrieval",
    "worker",
    "correction_learning"
)
$initial = Get-ProvenLoopStatus
$initialState = @{}
foreach ($capability in $capabilities) {
    $initialState[$capability] = Get-CapabilityEnabled `
        $initial `
        $capability
}
$checks = [ordered]@{}
$automatedTestPassed = $false
$automatedTestReportDigest = $null
if ($AutomatedTestReport) {
    $tests = Get-Content -LiteralPath $AutomatedTestReport -Raw |
        ConvertFrom-Json
    $automatedTestPassed = (
        $tests.success -is [bool] -and
        $tests.success -eq $true -and
        (Test-TestCount $tests.numTotalTests) -and
        (Test-TestCount $tests.numPassedTests) -and
        (Test-TestCount $tests.numFailedTests) -and
        $tests.numTotalTests -gt 0 -and
        $tests.numPassedTests -eq $tests.numTotalTests -and
        $tests.numFailedTests -eq 0
    )
    $automatedTestReportDigest = Get-ReportDigest $AutomatedTestReport
}

try {
    foreach ($capability in $capabilities) {
        & provenloop enable $capability --data-root $DataRoot | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to enable $capability for the probe."
        }
    }

    & provenloop disable retrieval --data-root $DataRoot | Out-Null
    $retrievalStatus = Get-ProvenLoopStatus
    $checks.retrievalDisabledPassed = (
        -not (Get-CapabilityEnabled $retrievalStatus "retrieval") -and
        (Get-CapabilityEnabled $retrievalStatus "capture")
    )
    & provenloop enable retrieval --data-root $DataRoot | Out-Null

    & provenloop disable capture --data-root $DataRoot | Out-Null
    $captureStatus = Get-ProvenLoopStatus
    $checks.captureDisabledPassed = (
        -not (Get-CapabilityEnabled $captureStatus "capture") -and
        (Get-CapabilityEnabled $captureStatus "retrieval")
    )
    & provenloop enable capture --data-root $DataRoot | Out-Null

    & provenloop disable worker --data-root $DataRoot | Out-Null
    $workerRun = & provenloop worker run --data-root $DataRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Disabled worker probe failed."
    }
    $workerResult = $workerRun | ConvertFrom-Json
    $checks.workerDisabledPassed = $workerResult.status -eq "disabled"
    & provenloop enable worker --data-root $DataRoot | Out-Null

    & provenloop disable correction_learning `
        --data-root $DataRoot | Out-Null
    $correctionStatus = Get-ProvenLoopStatus
    $checks.correctionLearningDisabledPassed = -not (
        Get-CapabilityEnabled `
            $correctionStatus `
            "correction_learning"
    )

    $passed = -not (
        $checks.Values |
            Where-Object { -not $_ }
    )
    $report = [ordered]@{
        schemaVersion = 1
        probeVersion = 1
        capturedAt = [DateTimeOffset]::UtcNow.ToString("o")
        automatedTestPassed = $automatedTestPassed
        automatedTestExecutedByProbe = $false
        automatedTestExecution = if ($AutomatedTestReport) {
            "reported_not_verified"
        } else {
            "not_observed"
        }
        automatedTestReportDigest = $automatedTestReportDigest
        automatedTestEvidence = if ($AutomatedTestReport) {
            "supplied_test_runner_report"
        } else {
            "not_supplied"
        }
        installedProbeScope = "capability_configuration_and_worker_disable"
        installedProbePassed = [bool]$passed
        retrievalDisabledPassed = $checks.retrievalDisabledPassed
        captureDisabledPassed = $checks.captureDisabledPassed
        workerDisabledPassed = $checks.workerDisabledPassed
        correctionLearningDisabledPassed = (
            $checks.correctionLearningDisabledPassed
        )
        status = if (-not $passed) {
            "fail"
        } elseif ($automatedTestPassed) {
            "pass"
        } else {
            "incomplete"
        }
    }
    $directory = Split-Path -Parent $OutputPath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $report | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath $OutputPath -Encoding utf8
    $report | ConvertTo-Json -Depth 5
} finally {
    foreach ($capability in $capabilities) {
        $operation = if ($initialState[$capability]) {
            "enable"
        } else {
            "disable"
        }
        & provenloop $operation $capability `
            --data-root $DataRoot | Out-Null
    }
}
