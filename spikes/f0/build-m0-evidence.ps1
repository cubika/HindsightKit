param(
    [Parameter(Mandatory)]
    [string]$BaselineM0Report,
    [Parameter(Mandatory)]
    [string]$CaptureReport,
    [Parameter(Mandatory)]
    [string]$ProviderDegradationReport,
    [Parameter(Mandatory)]
    [string]$MarketplaceUpgradeReport,
    [Parameter(Mandatory)]
    [string]$CapabilityIsolationReport,
    [Parameter(Mandatory)]
    [string]$ObservedGuardrailsReport,
    [Parameter(Mandatory)]
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "report-digest.ps1")

function Read-Json([string]$Path) {
    Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Get-Digest([string]$Path) {
    Get-ReportDigest $Path
}

function Assert-Fields(
    [object]$Value,
    [string[]]$Fields,
    [string]$Label
) {
    if ($null -eq $Value) {
        throw "$Label is missing."
    }
    $available = @($Value.PSObject.Properties.Name)
    foreach ($field in $Fields) {
        if ($field -notin $available) {
            throw "$Label is missing required field '$field'."
        }
    }
}

function Assert-StringFields(
    [object]$Value,
    [string[]]$Fields,
    [string]$Label
) {
    foreach ($field in $Fields) {
        $item = $Value.$field
        if (
            $item -isnot [string] -or
            [string]::IsNullOrWhiteSpace($item)
        ) {
            throw "$Label field '$field' must be a non-empty string."
        }
    }
}

function Assert-BooleanFields(
    [object]$Value,
    [string[]]$Fields,
    [string]$Label
) {
    foreach ($field in $Fields) {
        if ($Value.$field -isnot [bool]) {
            throw "$Label field '$field' must be a Boolean."
        }
    }
}

function Assert-NumberFields(
    [object]$Value,
    [string[]]$Fields,
    [string]$Label
) {
    $numberTypes = @(
        [byte],
        [decimal],
        [double],
        [int16],
        [int32],
        [int64],
        [sbyte],
        [single],
        [uint16],
        [uint32],
        [uint64]
    )
    foreach ($field in $Fields) {
        $item = $Value.$field
        if (
            $null -eq $item -or
            $item.GetType() -notin $numberTypes -or
            [double]::IsNaN([double]$item) -or
            [double]::IsInfinity([double]$item) -or
            [double]$item -lt 0
        ) {
            throw "$Label field '$field' must be a non-negative number."
        }
    }
}

function Assert-StringArrayField(
    [object]$Value,
    [string]$Field,
    [string]$Label
) {
    $items = $Value.$Field
    if (
        $null -eq $items -or
        $items -is [string] -or
        $items -isnot [System.Collections.IEnumerable]
    ) {
        throw "$Label field '$Field' must be an array."
    }
    $items = @($items)
    if (
        $items.Count -eq 0 -or
        $items |
            Where-Object {
                $_ -isnot [string] -or
                [string]::IsNullOrWhiteSpace($_)
            }
    ) {
        throw "$Label field '$Field' must contain non-empty strings."
    }
}

$baseline = Read-Json $BaselineM0Report
$pluginVersion = node -p "require('./package.json').version"
if ($LASTEXITCODE -ne 0) {
    throw "Unable to resolve the ProvenLoop package version."
}
$capture = Read-Json $CaptureReport
$provider = Read-Json $ProviderDegradationReport
$marketplace = Read-Json $MarketplaceUpgradeReport
$capability = Read-Json $CapabilityIsolationReport
$guardrails = Read-Json $ObservedGuardrailsReport
Assert-Fields $baseline @(
    "codeVersion",
    "runtimeDigest"
) "Baseline M0 report"
Assert-Fields $capture @(
    "status",
    "foregroundAddedLatencyP95Ms",
    "callbackWorkDurationP95Ms",
    "missingRequiredEventCount",
    "duplicateCanonicalFactCount",
    "seededSecretPersistenceCount",
    "internalSessionPersistenceCount",
    "foregroundBlockingFailureCount",
    "windows10RepresentativeEventCount",
    "windows11RepresentativeEventCount",
    "operatingSystemVersions",
    "copilotCliVersion",
    "captureRunIds"
) "Capture report"
Assert-Fields $provider @(
    "status",
    "signedOut",
    "rateLimited",
    "unavailable",
    "incompatible",
    "backlogDurable",
    "boundedRetry",
    "foregroundUsable",
    "classifications"
) "Provider degradation report"
Assert-Fields $marketplace @(
    "status",
    "fromVersion",
    "toVersion",
    "disableEnablePassed",
    "repeatedInstallPassed",
    "knowledgeDataPreserved",
    "queueDataPreserved",
    "uninstallPreservedData",
    "settingsRestoredExactly"
) "Marketplace upgrade report"
Assert-Fields $capability @(
    "status",
    "automatedTestPassed",
    "installedProbePassed",
    "retrievalDisabledPassed",
    "captureDisabledPassed",
    "workerDisabledPassed",
    "correctionLearningDisabledPassed"
) "Capability isolation report"
Assert-Fields $guardrails @(
    "secretPersistenceCount",
    "internalSessionPersistenceCount",
    "foregroundBlockingFailureCount",
    "crossRepositoryLeakageCount",
    "deletionPropagationFailureCount"
) "Observed guardrails report"
Assert-StringFields $baseline @(
    "codeVersion",
    "runtimeDigest"
) "Baseline M0 report"
Assert-StringFields $capture @(
    "status",
    "copilotCliVersion"
) "Capture report"
Assert-NumberFields $capture @(
    "foregroundAddedLatencyP95Ms",
    "callbackWorkDurationP95Ms",
    "missingRequiredEventCount",
    "duplicateCanonicalFactCount",
    "seededSecretPersistenceCount",
    "internalSessionPersistenceCount",
    "foregroundBlockingFailureCount",
    "windows10RepresentativeEventCount",
    "windows11RepresentativeEventCount"
) "Capture report"
Assert-StringArrayField $capture "operatingSystemVersions" "Capture report"
Assert-StringArrayField $capture "captureRunIds" "Capture report"
Assert-StringFields $provider @(
    "status",
    "signedOut",
    "rateLimited",
    "unavailable",
    "incompatible"
) "Provider degradation report"
Assert-BooleanFields $provider @(
    "backlogDurable",
    "boundedRetry",
    "foregroundUsable"
) "Provider degradation report"
Assert-StringArrayField $provider "classifications" (
    "Provider degradation report"
)
Assert-StringFields $marketplace @(
    "status",
    "fromVersion",
    "toVersion"
) "Marketplace upgrade report"
if ($marketplace.toVersion -ne $pluginVersion) {
    throw "Marketplace target version does not match the package version."
}
if ($marketplace.fromVersion -eq $marketplace.toVersion) {
    throw "Marketplace evidence must represent a real version transition."
}
Assert-BooleanFields $marketplace @(
    "disableEnablePassed",
    "repeatedInstallPassed",
    "knowledgeDataPreserved",
    "queueDataPreserved",
    "uninstallPreservedData",
    "settingsRestoredExactly"
) "Marketplace upgrade report"
Assert-StringFields $capability @(
    "status"
) "Capability isolation report"
Assert-BooleanFields $capability @(
    "automatedTestPassed",
    "installedProbePassed",
    "retrievalDisabledPassed",
    "captureDisabledPassed",
    "workerDisabledPassed",
    "correctionLearningDisabledPassed"
) "Capability isolation report"
Assert-NumberFields $guardrails @(
    "secretPersistenceCount",
    "internalSessionPersistenceCount",
    "foregroundBlockingFailureCount",
    "crossRepositoryLeakageCount",
    "deletionPropagationFailureCount"
) "Observed guardrails report"

$captureDigest = Get-Digest $CaptureReport
$providerDigest = Get-Digest $ProviderDegradationReport
$marketplaceDigest = Get-Digest $MarketplaceUpgradeReport
$capabilityDigest = Get-Digest $CapabilityIsolationReport
$guardrailsDigest = Get-Digest $ObservedGuardrailsReport
$reportDigests = @(
    $captureDigest
    $providerDigest
    $marketplaceDigest
    $capabilityDigest
    $guardrailsDigest
)
if (@($reportDigests | Select-Object -Unique).Count -ne 5) {
    throw "M0 source reports must have distinct SHA-256 digests."
}
$directory = Split-Path -Parent ([IO.Path]::GetFullPath($OutputPath))
$artifactDirectory = Join-Path $directory "m0-source-reports"
New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
$reportArtifacts = @()
foreach ($sourcePath in @(
    $CaptureReport,
    $ProviderDegradationReport,
    $MarketplaceUpgradeReport,
    $CapabilityIsolationReport,
    $ObservedGuardrailsReport
)) {
    $digest = Get-Digest $sourcePath
    $destination = Join-Path $artifactDirectory "$digest.json"
    if ([IO.Path]::GetFullPath($sourcePath) -ne $destination) {
        Copy-Item -LiteralPath $sourcePath -Destination $destination -Force
    }
    if ((Get-Digest $destination) -ne $digest) {
        throw "A source report changed while it was retained."
    }
    $reportArtifacts += [ordered]@{
        path = "m0-source-reports\$digest.json"
        sha256 = $digest
    }
}

$classifications = @(
    "available",
    "signed_out",
    "rate_limited",
    "incompatible",
    "unavailable"
)
$evidence = [ordered]@{
    evidenceVersion = 1
    binding = [ordered]@{
        codeVersion = [string]$baseline.codeVersion
        runtimeDigest = [string]$baseline.runtimeDigest
        operatingSystemVersions = @(
            $capture.operatingSystemVersions
        )
        copilotCliVersion = [string]$capture.copilotCliVersion
        pluginVersion = [string]$pluginVersion
        fixtureVersion = 1
        probeVersion = 1
        captureRunIds = @($capture.captureRunIds)
        reportDigests = $reportDigests
        reportArtifacts = $reportArtifacts
    }
    capture = [ordered]@{
        status = [string]$capture.status
        foregroundAddedLatencyP95Ms = [double](
            $capture.foregroundAddedLatencyP95Ms
        )
        callbackWorkDurationP95Ms = [double](
            $capture.callbackWorkDurationP95Ms
        )
        missingRequiredEventCount = [int](
            $capture.missingRequiredEventCount
        )
        duplicateCanonicalFactCount = [int](
            $capture.duplicateCanonicalFactCount
        )
        seededSecretPersistenceCount = [int](
            $capture.seededSecretPersistenceCount
        )
        internalSessionPersistenceCount = [int](
            $capture.internalSessionPersistenceCount
        )
        foregroundBlockingFailureCount = [int](
            $capture.foregroundBlockingFailureCount
        )
        windows10RepresentativeEventCount = [int](
            $capture.windows10RepresentativeEventCount
        )
        windows11RepresentativeEventCount = [int](
            $capture.windows11RepresentativeEventCount
        )
        reportDigest = $captureDigest
    }
    providerDegradation = [ordered]@{
        status = [string]$provider.status
        signedOut = [string]$provider.signedOut
        rateLimited = [string]$provider.rateLimited
        unavailable = [string]$provider.unavailable
        incompatible = [string]$provider.incompatible
        backlogDurable = [bool]$provider.backlogDurable
        boundedRetry = [bool]$provider.boundedRetry
        foregroundUsable = [bool]$provider.foregroundUsable
        reportDigest = $providerDigest
    }
    marketplaceUpgrade = [ordered]@{
        status = [string]$marketplace.status
        source = "cubika/ProvenLoop"
        fromVersion = [string]$marketplace.fromVersion
        toVersion = [string]$marketplace.toVersion
        disableEnablePassed = [bool]$marketplace.disableEnablePassed
        repeatedInstallPassed = [bool]$marketplace.repeatedInstallPassed
        knowledgeDataPreserved = [bool]$marketplace.knowledgeDataPreserved
        queueDataPreserved = [bool]$marketplace.queueDataPreserved
        uninstallPreservedData = [bool]$marketplace.uninstallPreservedData
        settingsRestoredExactly = [bool]$marketplace.settingsRestoredExactly
        reportDigest = $marketplaceDigest
    }
    doctor = [ordered]@{
        status = if (
            $classifications |
                Where-Object { $_ -notin @($provider.classifications) }
        ) {
            "fail"
        } else {
            "pass"
        }
        passiveStatus = "unverified"
        passiveModelRequestCount = 0
        passiveCredentialInspection = $false
        onlineClassifications = @($provider.classifications)
        reportDigest = $providerDigest
    }
    capabilityIsolation = [ordered]@{
        status = [string]$capability.status
        automatedTestPassed = [bool]$capability.automatedTestPassed
        installedProbePassed = [bool]$capability.installedProbePassed
        retrievalDisabledPassed = [bool](
            $capability.retrievalDisabledPassed
        )
        captureDisabledPassed = [bool]$capability.captureDisabledPassed
        workerDisabledPassed = [bool]$capability.workerDisabledPassed
        correctionLearningDisabledPassed = [bool](
            $capability.correctionLearningDisabledPassed
        )
        reportDigest = $capabilityDigest
    }
    observedGuardrails = [ordered]@{
        secretPersistenceCount = [int]$guardrails.secretPersistenceCount
        internalSessionPersistenceCount = [int](
            $guardrails.internalSessionPersistenceCount
        )
        foregroundBlockingFailureCount = [int](
            $guardrails.foregroundBlockingFailureCount
        )
        crossRepositoryLeakageCount = [int](
            $guardrails.crossRepositoryLeakageCount
        )
        deletionPropagationFailureCount = [int](
            $guardrails.deletionPropagationFailureCount
        )
    }
}

New-Item -ItemType Directory -Path $directory -Force | Out-Null
$json = $evidence | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText(
    $OutputPath,
    "$json`r`n",
    (New-Object Text.UTF8Encoding($false))
)
$evidence | ConvertTo-Json -Depth 8
