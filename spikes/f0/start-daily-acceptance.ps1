param(
    [string]$DataRoot,
    [string]$SessionRoot
)

$ErrorActionPreference = "Stop"

$arguments = @("acceptance", "start")
if ($DataRoot) {
    $arguments += @("--data-root", $DataRoot)
}
if ($SessionRoot) {
    $arguments += @("--session-root", $SessionRoot)
}

& provenloop @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Failed to start the M0 daily acceptance run."
}
