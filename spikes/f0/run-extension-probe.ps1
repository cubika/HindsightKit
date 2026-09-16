param(
    [ValidateSet("baseline", "delay", "throw", "exit")]
    [string]$Mode = "baseline",
    [switch]$Internal,
    [switch]$OmitExperimentalFlag,
    [switch]$ExpectExtensionDisabled,
    [string]$CopilotHome
)

$ErrorActionPreference = "Stop"

$f0Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginRoot = Join-Path (
    $f0Root
) "copilot-marketplace\plugins\provenloop-extension-probe"
$runId = [Guid]::NewGuid().ToString("N")
$logPath = Join-Path (
    [IO.Path]::GetTempPath()
) "provenloop-f0-extension-$Mode-$runId.jsonl"
$registryPath = Join-Path (
    [IO.Path]::GetTempPath()
) "provenloop-f0-internal-sessions-$runId.json"

$previousLogPath = $env:PROVENLOOP_F0_EXTENSION_LOG
$previousMode = $env:PROVENLOOP_F0_EXTENSION_MODE
$previousRegistry = $env:PROVENLOOP_F0_INTERNAL_REGISTRY
$previousInternal = $env:PROVENLOOP_INTERNAL
$previousCopilotHome = $env:COPILOT_HOME
$previousDelay = $env:PROVENLOOP_F0_EXTENSION_DELAY_MS
$env:PROVENLOOP_F0_EXTENSION_LOG = $logPath
$env:PROVENLOOP_F0_EXTENSION_MODE = $Mode
$env:PROVENLOOP_F0_EXTENSION_DELAY_MS = "500"

Remove-Item $logPath, $registryPath -Force -ErrorAction SilentlyContinue

try {
    $sessionId = [Guid]::NewGuid().ToString()
    if ($Internal) {
        ConvertTo-Json -InputObject @($sessionId) |
            Set-Content -Encoding utf8 $registryPath
        $env:PROVENLOOP_F0_INTERNAL_REGISTRY = $registryPath
        $env:PROVENLOOP_INTERNAL = "1"
    }
    if ($CopilotHome) {
        $env:COPILOT_HOME = $CopilotHome
    }

    $arguments = @()
    if (-not $OmitExperimentalFlag) {
        $arguments += "--experimental"
    }
    $arguments += @(
        "--plugin-dir",
        $pluginRoot,
        "--session-id",
        $sessionId,
        "-p",
        "Use PowerShell once to output EXTENSION_PROBE_TOOL_OK, then reply with exactly EXTENSION_PROBE_OK.",
        "--silent",
        "--allow-all-tools",
        "--available-tools=powershell",
        "--no-custom-instructions",
        "--disable-builtin-mcps",
        "--no-auto-update"
    )

    $watch = [Diagnostics.Stopwatch]::StartNew()
    $output = & copilot @arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    $watch.Stop()

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (
        [DateTime]::UtcNow -lt $deadline -and
        -not (Test-Path $logPath)
    ) {
        Start-Sleep -Milliseconds 50
    }
    Start-Sleep -Milliseconds 500

    $records = if (Test-Path $logPath) {
        @(Get-Content $logPath | ForEach-Object { $_ | ConvertFrom-Json })
    } else {
        @()
    }
    $events = @($records | Where-Object { $_.kind -eq "session.event" })
    $faultRecords = @(
        $records | Where-Object { $_.kind -eq "probe.fault_injected" }
    )
    $faultCompletionRecords = @(
        $records | Where-Object { $_.kind -eq "probe.fault_completed" }
    )
    $callbackRecords = @(
        $records | Where-Object { $_.kind -eq "probe.callback_metric" }
    )
    $skippedInternalEvents = @(
        $records | Where-Object { $_.kind -eq "probe.internal_skipped" }
    )
    $eventTypes = @($events | ForEach-Object { $_.type } | Sort-Object -Unique)
    $requiredTypes = @(
        "user.message",
        "tool.execution_start",
        "tool.execution_complete",
        "assistant.message",
        "assistant.turn_end"
    )
    $p95 = {
        param([double[]]$Samples)
        if ($Samples.Count -eq 0) {
            return $null
        }
        $index = [Math]::Min(
            $Samples.Count - 1,
            [Math]::Ceiling($Samples.Count * 0.95) - 1
        )
        return [Math]::Round($Samples[$index], 3)
    }
    $deliverySamples = @(
        $events |
            Where-Object { $null -ne $_.deliveryLatencyMs } |
            ForEach-Object { [double]$_.deliveryLatencyMs } |
            Sort-Object
    )
    $requiredEvents = @(
        $events | Where-Object { $_.type -in $requiredTypes }
    )
    $requiredDeliverySamples = @(
        $requiredEvents |
            Where-Object { $null -ne $_.deliveryLatencyMs } |
            ForEach-Object { [double]$_.deliveryLatencyMs } |
            Sort-Object
    )
    $deliveryLatencyByType = [ordered]@{}
    $events |
        Group-Object type |
        ForEach-Object {
            $samples = @(
                $_.Group |
                    Where-Object { $null -ne $_.deliveryLatencyMs } |
                    ForEach-Object { [double]$_.deliveryLatencyMs } |
                    Sort-Object
            )
            $deliveryLatencyByType[$_.Name] = [ordered]@{
                count = $samples.Count
                p95Ms = & $p95 $samples
                maxMs = if ($samples.Count -gt 0) {
                    [Math]::Round($samples[-1], 3)
                } else {
                    $null
                }
            }
        }
    $callbackSamples = @(
        $callbackRecords |
            ForEach-Object { [double]$_.callbackWorkDurationMs } |
            Sort-Object
    )
    $invalidTimestampCount = 0
    foreach ($event in $events) {
        $parsedTimestamp = [DateTime]::MinValue
        if (
            -not [DateTime]::TryParse(
                [string]$event.timestamp,
                [ref]$parsedTimestamp
            )
        ) {
            $invalidTimestampCount += 1
        }
    }

    $missingTypes = @(
        $requiredTypes | Where-Object { $_ -notin $eventTypes }
    )
    $rawLog = if (Test-Path $logPath) {
        Get-Content $logPath -Raw
    } else {
        ""
    }

    $result = [ordered]@{
        mode = $Mode
        copilotExitCode = $exitCode
        foregroundCompleted = $output -match "EXTENSION_PROBE_OK"
        durationMs = [Math]::Round($watch.Elapsed.TotalMilliseconds, 2)
        extensionStarted = [bool](
            $records | Where-Object { $_.kind -eq "probe.started" }
        )
        internalSessionRecognized = [bool](
            $records |
                Where-Object {
                    $_.kind -eq "probe.started" -and
                    $_.internal -eq $true
                }
        )
        skippedInternalEventCount = $skippedInternalEvents.Count
        eventCount = $events.Count
        eventTypes = $eventTypes
        missingRequiredTypes = $missingTypes
        eventIdsValid = (
            @($events | Where-Object { -not $_.id }).Count -eq 0
        )
        eventTimestampsValid = $invalidTimestampCount -eq 0
        latencySampleComplete = $deliverySamples.Count -eq $events.Count
        allEventDeliveryLatencyP95Ms = & $p95 $deliverySamples
        requiredEventDeliveryLatencyP95Ms = & $p95 $requiredDeliverySamples
        deliveryLatencyByType = $deliveryLatencyByType
        callbackSampleComplete = $callbackSamples.Count -eq $events.Count
        callbackWorkDurationP95Ms = & $p95 $callbackSamples
        faultInjected = [bool](
            $faultRecords |
                Where-Object {
                    $_.mode -eq $Mode -and
                    $_.eventType -eq "user.message"
                }
        )
        injectedDelayMs = (
            $faultCompletionRecords |
                Where-Object {
                    $_.mode -eq "delay" -and
                    $_.eventType -eq "user.message"
                } |
                Select-Object -First 1 -ExpandProperty elapsedMs
        )
        rawContentPersisted = (
            $rawLog -match "EXTENSION_PROBE_TOOL_OK|EXTENSION_PROBE_OK"
        )
    }

    $passed = (
        $result.copilotExitCode -eq 0 -and
        $result.foregroundCompleted
    )
    if ($Mode -eq "baseline") {
        if ($ExpectExtensionDisabled) {
            $passed = (
                $passed -and
                -not $result.extensionStarted -and
                $result.eventCount -eq 0
            )
        } elseif ($Internal) {
            $passed = (
                $passed -and
                $result.extensionStarted -and
                $result.internalSessionRecognized -and
                $result.skippedInternalEventCount -gt 0 -and
                $result.eventCount -eq 0 -and
                -not $result.rawContentPersisted
            )
        } else {
            $passed = (
                $passed -and
                $result.extensionStarted -and
                $result.eventCount -gt 0 -and
                $result.missingRequiredTypes.Count -eq 0 -and
                $result.eventIdsValid -and
                $result.eventTimestampsValid -and
                $result.latencySampleComplete -and
                $result.callbackSampleComplete -and
                $result.callbackWorkDurationP95Ms -le 1 -and
                -not $result.rawContentPersisted
            )
        }
    } else {
        $passed = (
            $passed -and
            $result.extensionStarted -and
            $result.faultInjected
        )
        if ($Mode -eq "delay") {
            $passed = (
                $passed -and
                $result.injectedDelayMs -ge 450
            )
        }
    }

    if (-not $passed) {
        throw "Extension probe failed: $(
            $result | ConvertTo-Json -Depth 5 -Compress
        )"
    }

    $result | ConvertTo-Json -Depth 5
} finally {
    $env:PROVENLOOP_F0_EXTENSION_LOG = $previousLogPath
    $env:PROVENLOOP_F0_EXTENSION_MODE = $previousMode
    $env:PROVENLOOP_F0_INTERNAL_REGISTRY = $previousRegistry
    $env:PROVENLOOP_INTERNAL = $previousInternal
    $env:COPILOT_HOME = $previousCopilotHome
    $env:PROVENLOOP_F0_EXTENSION_DELAY_MS = $previousDelay
    Remove-Item $logPath, $registryPath -Force -ErrorAction SilentlyContinue
}
