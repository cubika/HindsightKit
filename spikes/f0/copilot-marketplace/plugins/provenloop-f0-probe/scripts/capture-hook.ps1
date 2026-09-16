param(
    [Parameter(Mandatory = $true)]
    [string]$EventName
)

$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json -AsHashtable
$record = [ordered]@{
    event = $EventName
    internal = $env:PROVENLOOP_INTERNAL
    payload = $payload
}

$logPath = if ($env:PROVENLOOP_F0_HOOK_LOG) {
    $env:PROVENLOOP_F0_HOOK_LOG
} else {
    Join-Path ([IO.Path]::GetTempPath()) "provenloop-f0-hooks.jsonl"
}

$record | ConvertTo-Json -Depth 20 -Compress | Add-Content -Encoding utf8 -Path $logPath
Write-Output "{}"
