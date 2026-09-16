param(
    [string]$DataRoot,
    [ValidateRange(1, 600)]
    [int]$DrainTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"

$arguments = @(
    "acceptance",
    "complete",
    "--drain-timeout",
    $DrainTimeoutSeconds
)
if ($DataRoot) {
    $arguments += @("--data-root", $DataRoot)
}

& provenloop @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Failed to complete the M0 daily acceptance run."
}
