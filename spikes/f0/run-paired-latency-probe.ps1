param(
    [string]$DataRoot,
    [string]$BaselineSamples,
    [string]$ProvenLoopSamples,
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "report-digest.ps1")

if (-not $DataRoot) {
    if (-not $env:LOCALAPPDATA) {
        throw "LOCALAPPDATA is required when -DataRoot is omitted."
    }
    $DataRoot = Join-Path $env:LOCALAPPDATA "ProvenLoop"
}
$probeRoot = Join-Path $DataRoot "evaluation\m0-probes"
if (-not $BaselineSamples) {
    $BaselineSamples = Join-Path $probeRoot "foreground-baseline-ms.json"
}
if (-not $ProvenLoopSamples) {
    $ProvenLoopSamples = Join-Path $probeRoot "foreground-provenloop-ms.json"
}
if (-not $OutputPath) {
    $OutputPath = Join-Path $probeRoot "paired-latency-report.json"
}

$baseline = ConvertFrom-Json -InputObject (
    Get-Content -LiteralPath $BaselineSamples -Raw
)
$enabled = ConvertFrom-Json -InputObject (
    Get-Content -LiteralPath $ProvenLoopSamples -Raw
)
if (
    $baseline.Count -lt 100 -or
    $baseline.Count -ne $enabled.Count
) {
    throw "Paired latency inputs must contain at least 100 equal-length samples."
}

$deltas = for ($index = 0; $index -lt $baseline.Count; $index += 1) {
    foreach ($sample in @($baseline[$index], $enabled[$index])) {
        if ($null -eq $sample -or $sample -is [bool] -or $sample -is [string]) {
            throw "Latency samples must be numeric observations, not missing values or strings."
        }
    }
    $left = [double]$baseline[$index]
    $right = [double]$enabled[$index]
    if (
        [double]::IsNaN($left) -or
        [double]::IsNaN($right) -or
        [double]::IsInfinity($left) -or
        [double]::IsInfinity($right) -or
        $left -lt 0 -or
        $right -lt 0
    ) {
        throw "Latency samples must be finite non-negative numbers."
    }
    $right - $left
}
$sorted = @($deltas | Sort-Object)
$p95Index = [Math]::Min(
    $sorted.Count - 1,
    [Math]::Ceiling($sorted.Count * 0.95) - 1
)
$p95 = [Math]::Round([double]$sorted[$p95Index], 3)
$report = [ordered]@{
    schemaVersion = 1
    probeVersion = 1
    evidenceKind = "supplied_measurements"
    pairing = "caller_supplied_order"
    baselineDigest = Get-ReportDigest $BaselineSamples
    enabledDigest = Get-ReportDigest $ProvenLoopSamples
    capturedAt = [DateTimeOffset]::UtcNow.ToString("o")
    operatingSystemVersion = [Environment]::OSVersion.VersionString
    sampleCount = $sorted.Count
    foregroundAddedLatencyP95Ms = [Math]::Max(0, $p95)
    pairedDeltaP95Ms = $p95
    status = if ($p95 -le 10) { "pass" } else { "fail" }
}

$directory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$report | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath $OutputPath -Encoding utf8
$report | ConvertTo-Json -Depth 4
