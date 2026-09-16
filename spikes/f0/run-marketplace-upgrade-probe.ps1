param(
    [Parameter(Mandatory)]
    [string]$FromVersion,
    [string]$DataRoot,
    [string]$ExpectedSettingsPath,
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
    ) "evaluation\m0-probes\marketplace-upgrade-report.json"
}

$queueRoot = Join-Path $DataRoot "queue"
$toVersion = node -p "require('./package.json').version"
if ($LASTEXITCODE -ne 0) {
    throw "Unable to resolve the ProvenLoop package version."
}
$beforeStatus = & provenloop status --data-root $DataRoot |
    ConvertFrom-Json
if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect the installed pre-upgrade version."
}
$installedFromVersion = [string]$beforeStatus.pluginVersion
if ($installedFromVersion -ne $FromVersion) {
    throw (
        "Installed plugin version '$installedFromVersion' does not match " +
        "the expected source version '$FromVersion'."
    )
}
if ($FromVersion -eq $toVersion) {
    throw "Marketplace upgrade evidence requires two distinct versions."
}
$knowledgePath = Join-Path $DataRoot "backends\knowledge.db"
$canonicalPath = Join-Path $DataRoot "data\provenloop.db"
$queueFilesBefore = @(
    Get-ChildItem $queueRoot -File -Recurse -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName
)
$knowledgePresentBefore = Test-Path -LiteralPath $knowledgePath
$canonicalPresentBefore = Test-Path -LiteralPath $canonicalPath

& provenloop upgrade --data-root $DataRoot | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Remote marketplace upgrade failed."
}
$afterStatus = & provenloop status --data-root $DataRoot |
    ConvertFrom-Json
if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect the installed post-upgrade version."
}
$installedToVersion = [string]$afterStatus.pluginVersion
if ($installedToVersion -ne $toVersion) {
    throw (
        "Installed plugin version '$installedToVersion' does not match " +
        "the target package version '$toVersion'."
    )
}
& provenloop disable retrieval --data-root $DataRoot | Out-Null
$disableExitCode = $LASTEXITCODE
$disabledStatus = & provenloop status --data-root $DataRoot |
    ConvertFrom-Json
$retrievalDisabled = -not [bool](
    $disabledStatus.capabilities.capabilities |
        Where-Object capability -EQ "retrieval" |
        Select-Object -ExpandProperty enabled
)
& provenloop enable retrieval --data-root $DataRoot | Out-Null
$enableExitCode = $LASTEXITCODE
$enabledStatus = & provenloop status --data-root $DataRoot |
    ConvertFrom-Json
$retrievalEnabled = [bool](
    $enabledStatus.capabilities.capabilities |
        Where-Object capability -EQ "retrieval" |
        Select-Object -ExpandProperty enabled
)
$disableEnablePassed = (
    $disableExitCode -eq 0 -and
    $enableExitCode -eq 0 -and
    $retrievalDisabled -and
    $retrievalEnabled
)
& provenloop install --data-root $DataRoot | Out-Null
$repeatedInstallPassed = $LASTEXITCODE -eq 0

& provenloop uninstall --data-root $DataRoot | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Normal uninstall failed after upgrade."
}
$uninstallPreservedData = (
    (Test-Path -LiteralPath $DataRoot) -and
    (Test-Path -LiteralPath $canonicalPath)
)
$queueDataPreserved = (
    $queueFilesBefore.Count -gt 0 -and
    -not (
        $queueFilesBefore |
            Where-Object { -not (Test-Path -LiteralPath $_) }
    )
)
$knowledgeDataPreserved = (
    $knowledgePresentBefore -and
    (Test-Path -LiteralPath $knowledgePath)
)
$settingsRestoredExactly = $false
if ($ExpectedSettingsPath) {
    $copilotHome = $env:COPILOT_HOME
    if (-not $copilotHome) {
        $copilotHome = Join-Path $HOME ".copilot"
    }
    $settingsPath = Join-Path $copilotHome "settings.json"
    $settingsRestoredExactly = (
        (Get-Content -LiteralPath $settingsPath -Raw) -ceq
        (Get-Content -LiteralPath $ExpectedSettingsPath -Raw)
    )
}

& provenloop install --data-root $DataRoot | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Reinstall failed after upgrade verification."
}

$passed = (
    $canonicalPresentBefore -and
    $disableEnablePassed -and
    $repeatedInstallPassed -and
    $knowledgeDataPreserved -and
    $queueDataPreserved -and
    $uninstallPreservedData -and
    $settingsRestoredExactly
)
$report = [ordered]@{
    schemaVersion = 1
    probeVersion = 1
    capturedAt = [DateTimeOffset]::UtcNow.ToString("o")
    source = "cubika/ProvenLoop"
    fromVersion = $installedFromVersion
    toVersion = $installedToVersion
    disableEnablePassed = $disableEnablePassed
    repeatedInstallPassed = $repeatedInstallPassed
    knowledgeDataPreserved = $knowledgeDataPreserved
    queueDataPreserved = $queueDataPreserved
    uninstallPreservedData = $uninstallPreservedData
    settingsRestoredExactly = $settingsRestoredExactly
    status = if ($passed) { "pass" } else { "fail" }
}

$directory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$report | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $OutputPath -Encoding utf8
$report | ConvertTo-Json -Depth 5
