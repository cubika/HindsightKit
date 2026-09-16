$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$captureScript = Join-Path $scriptRoot "capture-hook.ps1"
$logPath = Join-Path (
    [IO.Path]::GetTempPath()
) "provenloop-f0-command-hook-benchmark.jsonl"
$payload = @"
{"sessionId":"benchmark","timestamp":0,"cwd":"C:\\probe","source":"startup"}
"@
$samples = @()

$previousLogPath = $env:PROVENLOOP_F0_HOOK_LOG
$env:PROVENLOOP_F0_HOOK_LOG = $logPath
Remove-Item $logPath -Force -ErrorAction SilentlyContinue

try {
    1..15 | ForEach-Object {
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $payload | pwsh `
            -NoProfile `
            -File $captureScript `
            sessionStart | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Command Hook benchmark invocation failed."
        }
        $watch.Stop()
        $samples += $watch.Elapsed.TotalMilliseconds
    }

    $samples = @($samples | Sort-Object)
    $p95Index = [Math]::Min(
        $samples.Count - 1,
        [Math]::Ceiling($samples.Count * 0.95) - 1
    )

    [ordered]@{
        sampleCount = $samples.Count
        medianMs = [Math]::Round(
            $samples[[Math]::Floor($samples.Count / 2)],
            2
        )
        p95Ms = [Math]::Round($samples[$p95Index], 2)
        meetsTenMillisecondBudget = $samples[$p95Index] -le 10
    } | ConvertTo-Json
} finally {
    $env:PROVENLOOP_F0_HOOK_LOG = $previousLogPath
    Remove-Item $logPath -Force -ErrorAction SilentlyContinue
}
