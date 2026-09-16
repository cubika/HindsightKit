$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA is required to run ProvenLoop."
}
$locatorPath = Join-Path (
    $env:LOCALAPPDATA
) "ProvenLoopIntegration\runtime.json"
$runtime = Get-Content -LiteralPath $locatorPath -Raw -Encoding UTF8 |
    ConvertFrom-Json

function Test-AbsolutePath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $false
    }
    return $Path -match (
        "^(?:[A-Za-z]:[\\/]|" +
        "\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))"
    )
}

if (
    $runtime.product -ne "ProvenLoopRuntime" -or
    $runtime.schemaVersion -ne 1 -or
    $runtime.version -ne "0.1.0-alpha.0.16" -or
    -not (Test-AbsolutePath ([string]$runtime.nodeExecutable)) -or
    -not (Test-AbsolutePath ([string]$runtime.cliBinPath)) -or
    -not (Test-AbsolutePath ([string]$runtime.dataRoot)) -or
    -not (Test-Path -LiteralPath $runtime.nodeExecutable -PathType Leaf) -or
    -not (Test-Path -LiteralPath $runtime.cliBinPath -PathType Leaf)
) {
    throw "The installed ProvenLoop runtime locator is invalid."
}

& $runtime.nodeExecutable `
    $runtime.cliBinPath `
    mcp `
    serve `
    --data-root `
    $runtime.dataRoot
exit $LASTEXITCODE
