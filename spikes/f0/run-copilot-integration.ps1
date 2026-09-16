$ErrorActionPreference = "Stop"

$f0Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginRoot = Join-Path $f0Root "copilot-marketplace\plugins\provenloop-f0-probe"
$failurePluginRoot = Join-Path $f0Root "copilot-failure-plugin"
$serverScript = Join-Path $pluginRoot "scripts\http-hook-probe.mjs"
$hookLog = Join-Path ([IO.Path]::GetTempPath()) "provenloop-f0-http-hooks.jsonl"
$mcpLog = Join-Path ([IO.Path]::GetTempPath()) "provenloop-f0-mcp.jsonl"
$serverOut = Join-Path ([IO.Path]::GetTempPath()) "provenloop-f0-http-server.out"
$serverErr = Join-Path ([IO.Path]::GetTempPath()) "provenloop-f0-http-server.err"

Remove-Item $hookLog, $mcpLog, $serverOut, $serverErr `
    -Force `
    -ErrorAction SilentlyContinue

$previousAllowLocalhost = $env:COPILOT_HOOK_ALLOW_LOCALHOST
$previousInternal = $env:PROVENLOOP_INTERNAL
$previousHookLog = $env:PROVENLOOP_F0_HTTP_HOOK_LOG
$authOverrideNames = @(
    "COPILOT_PROVIDER_BASE_URL",
    "COPILOT_PROVIDER_API_KEY",
    "COPILOT_PROVIDER_BEARER_TOKEN",
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN"
)
$configuredAuthOverrides = @(
    $authOverrideNames | Where-Object {
        [Environment]::GetEnvironmentVariable($_)
    }
)

$env:COPILOT_HOOK_ALLOW_LOCALHOST = "1"
$env:PROVENLOOP_INTERNAL = "1"
$env:PROVENLOOP_F0_HTTP_HOOK_LOG = $hookLog

$server = Start-Process node `
    -ArgumentList @($serverScript) `
    -RedirectStandardOutput $serverOut `
    -RedirectStandardError $serverErr `
    -PassThru
$serverPid = $server.Id

try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (
        [DateTime]::UtcNow -lt $deadline -and
        (-not (Test-Path $serverOut) -or (Get-Item $serverOut).Length -eq 0)
    ) {
        Start-Sleep -Milliseconds 50
    }

    if (-not (Test-Path $serverOut) -or (Get-Item $serverOut).Length -eq 0) {
        throw "The HTTP hook probe server did not start."
    }

    $onlineOutput = copilot `
        --plugin-dir $pluginRoot `
        -p "Call the provenloop-f0-probe echo tool with value HTTP_HOOK_OK, then reply with exactly HTTP_HOOK_OK." `
        --silent `
        --allow-all-tools `
        --available-tools=provenloop-f0-probe-echo `
        --no-custom-instructions `
        --disable-builtin-mcps `
        --no-auto-update 2>&1 | Out-String
    $onlineExitCode = $LASTEXITCODE

    if ($onlineExitCode -ne 0) {
        throw "The online Copilot probe failed with exit code $onlineExitCode."
    }

    Stop-Process -Id $serverPid
    $server.WaitForExit()
    Start-Sleep -Milliseconds 250

    $offlineWatch = [Diagnostics.Stopwatch]::StartNew()
    $offlineOutput = copilot `
        --plugin-dir $pluginRoot `
        -p "Reply with exactly HOOK_OFFLINE_OK and do not call tools." `
        --silent `
        --no-custom-instructions `
        --disable-builtin-mcps `
        --no-auto-update 2>&1 | Out-String
    $offlineExitCode = $LASTEXITCODE
    $offlineWatch.Stop()

    $failureWatch = [Diagnostics.Stopwatch]::StartNew()
    $failureOutput = copilot `
        --plugin-dir $failurePluginRoot `
        -p "Reply with exactly MCP_FAILURE_ISOLATED and do not call tools." `
        --silent `
        --no-custom-instructions `
        --disable-builtin-mcps `
        --no-auto-update 2>&1 | Out-String
    $failureExitCode = $LASTEXITCODE
    $failureWatch.Stop()

    $hookRecords = Get-Content $hookLog |
        ForEach-Object { $_ | ConvertFrom-Json }
    $mcpRecords = Get-Content $mcpLog |
        ForEach-Object { $_ | ConvertFrom-Json }
    $hookDispatchSamples = @(
        $hookRecords |
            Where-Object {
                $null -ne $_.payloadTimestamp -or
                $null -ne $_.payload.timestamp
            } |
            ForEach-Object {
                $payloadTimestamp = if ($null -ne $_.payloadTimestamp) {
                    $_.payloadTimestamp
                } else {
                    $_.payload.timestamp
                }
                $_.timestamp - $payloadTimestamp
            } |
            Sort-Object
    )
    $hookDispatchByEvent = [ordered]@{}
    $hookRecords |
        Where-Object {
            $null -ne $_.payloadTimestamp -or
            $null -ne $_.payload.timestamp
        } |
        ForEach-Object {
            $payloadTimestamp = if ($null -ne $_.payloadTimestamp) {
                $_.payloadTimestamp
            } else {
                $_.payload.timestamp
            }
            $hookDispatchByEvent[$_.path] = $_.timestamp - $payloadTimestamp
        }
    if ($hookDispatchSamples.Count -eq 0) {
        throw "No Hook dispatch samples were recorded."
    }
    $hookP95Index = [Math]::Min(
        $hookDispatchSamples.Count - 1,
        [Math]::Ceiling($hookDispatchSamples.Count * 0.95) - 1
    )
    $mcpProcessIds = @(
        $mcpRecords |
            Where-Object { $_.event -eq "processStart" } |
            ForEach-Object { $_.pid } |
            Sort-Object -Unique
    )
    Start-Sleep -Milliseconds 500
    $runningMcpProcessIds = @(
        $mcpProcessIds | Where-Object {
            $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue)
        }
    )

    $result = [ordered]@{
        copilotVersion = (copilot --version | Select-Object -First 1)
        configuredAuthOverrides = $configuredAuthOverrides
        onlineExitCode = $onlineExitCode
        onlineResponseObserved = $onlineOutput -match "HTTP_HOOK_OK"
        internalHeaderObserved = [bool](
            $hookRecords | Where-Object { $_.internal -eq "1" }
        )
        internalEventsDiscarded = (
            @(
                $hookRecords |
                    Where-Object { $_.event -eq "discardedInternal" }
            ).Count -eq $hookRecords.Count
        )
        hookPayloadsValid = (
            @(
                $hookRecords |
                    Where-Object { -not $_.valid }
            ).Count -eq 0
        )
        hookEvents = @($hookRecords | ForEach-Object { $_.path })
        hookDispatchMsByEvent = $hookDispatchByEvent
        hookDispatchP95Ms = $hookDispatchSamples[$hookP95Index]
        hookLatencyBudgetMet = (
            $hookDispatchSamples[$hookP95Index] -le 10
        )
        mcpToolCallObserved = [bool](
            $mcpRecords | Where-Object { $_.method -eq "tools/call" }
        )
        mcpProcessesStopped = $runningMcpProcessIds.Count -eq 0
        offlineExitCode = $offlineExitCode
        offlineResponseObserved = $offlineOutput -match "HOOK_OFFLINE_OK"
        offlineDurationMs = [Math]::Round(
            $offlineWatch.Elapsed.TotalMilliseconds,
            2
        )
        mcpFailureExitCode = $failureExitCode
        mcpFailureIsolated = $failureOutput -match "MCP_FAILURE_ISOLATED"
        mcpFailureDurationMs = [Math]::Round(
            $failureWatch.Elapsed.TotalMilliseconds,
            2
        )
    }

    $requiredEvents = @(
        "/hooks/sessionStart",
        "/hooks/userPromptSubmitted",
        "/hooks/preToolUse",
        "/hooks/postToolUse",
        "/hooks/agentStop",
        "/hooks/sessionEnd"
    )
    $missingEvents = @(
        $requiredEvents | Where-Object {
            $_ -notin $result.hookEvents
        }
    )
    $integrationPassed = (
        $result.configuredAuthOverrides.Count -eq 0 -and
        $result.onlineExitCode -eq 0 -and
        $result.onlineResponseObserved -and
        $result.internalHeaderObserved -and
        $result.internalEventsDiscarded -and
        $result.hookPayloadsValid -and
        $missingEvents.Count -eq 0 -and
        $result.mcpToolCallObserved -and
        $result.mcpProcessesStopped -and
        $result.offlineExitCode -eq 0 -and
        $result.offlineResponseObserved -and
        $result.mcpFailureExitCode -eq 0 -and
        $result.mcpFailureIsolated
    )

    if (-not $integrationPassed) {
        throw "Copilot integration checks failed: $(
            $result | ConvertTo-Json -Depth 5 -Compress
        )"
    }

    $result | ConvertTo-Json -Depth 5
} finally {
    if (-not $server.HasExited) {
        Stop-Process -Id $serverPid
        $server.WaitForExit()
    }

    $env:COPILOT_HOOK_ALLOW_LOCALHOST = $previousAllowLocalhost
    $env:PROVENLOOP_INTERNAL = $previousInternal
    $env:PROVENLOOP_F0_HTTP_HOOK_LOG = $previousHookLog

    Remove-Item $hookLog, $mcpLog, $serverOut, $serverErr `
        -Force `
        -ErrorAction SilentlyContinue
}
