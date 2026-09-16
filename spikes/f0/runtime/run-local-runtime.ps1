$ErrorActionPreference = "Stop"

$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$f0Root = Split-Path -Parent $runtimeRoot
$probeScriptRoot = Join-Path (
    $f0Root
) "copilot-marketplace\plugins\provenloop-f0-probe\scripts"
$leaseScript = Join-Path $runtimeRoot "named-pipe-lease.mjs"
$pipeName = "\\.\pipe\provenloop-f0-$([Guid]::NewGuid().ToString('N'))"
$stdoutPath = Join-Path ([IO.Path]::GetTempPath()) "provenloop-f0-lease-stdout.log"
$stderrPath = Join-Path ([IO.Path]::GetTempPath()) "provenloop-f0-lease-stderr.log"

Remove-Item $stdoutPath -Force -ErrorAction SilentlyContinue
Remove-Item $stderrPath -Force -ErrorAction SilentlyContinue

$coldStart = [Diagnostics.Stopwatch]::StartNew()
& node (Join-Path $runtimeRoot "node-sqlite-probe.mjs")
if ($LASTEXITCODE -ne 0) {
    throw "SQLite probe failed with exit code $LASTEXITCODE."
}
$coldStart.Stop()

& node (Join-Path $runtimeRoot "atomic-queue-probe.mjs") 1000
if ($LASTEXITCODE -ne 0) {
    throw "Atomic queue probe failed with exit code $LASTEXITCODE."
}

& node (Join-Path $probeScriptRoot "http-hook-benchmark.mjs") 200
if ($LASTEXITCODE -ne 0) {
    throw "HTTP Hook benchmark failed with exit code $LASTEXITCODE."
}

& pwsh `
    -NoProfile `
    -File (Join-Path $probeScriptRoot "command-hook-benchmark.ps1")
if ($LASTEXITCODE -ne 0) {
    throw "Command Hook benchmark failed with exit code $LASTEXITCODE."
}

$holder = Start-Process node `
    -ArgumentList @($leaseScript, $pipeName, "hold") `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (
        [DateTime]::UtcNow -lt $deadline -and
        (-not (Test-Path $stdoutPath) -or (Get-Item $stdoutPath).Length -eq 0)
    ) {
        Start-Sleep -Milliseconds 50
    }

    if (-not (Test-Path $stdoutPath) -or (Get-Item $stdoutPath).Length -eq 0) {
        throw "The first named-pipe lease did not start."
    }

    Get-Content $stdoutPath

    & node $leaseScript $pipeName once
    if ($LASTEXITCODE -ne 10) {
        throw "The second lease should fail with exit code 10, got $LASTEXITCODE."
    }

    Stop-Process -Id $holder.Id
    $holder.WaitForExit()

    & node $leaseScript $pipeName once
    if ($LASTEXITCODE -ne 0) {
        throw "The lease was not released after terminating the holder."
    }
} finally {
    if (-not $holder.HasExited) {
        Stop-Process -Id $holder.Id
        $holder.WaitForExit()
    }

    Remove-Item $stdoutPath -Force -ErrorAction SilentlyContinue
    Remove-Item $stderrPath -Force -ErrorAction SilentlyContinue
}

[ordered]@{
    nodeColdStartAndSqliteProbeMs = $coldStart.Elapsed.TotalMilliseconds
    namedPipeLeaseReleasedAfterTermination = $true
} | ConvertTo-Json
