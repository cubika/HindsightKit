[CmdletBinding()]
param(
    [string]$Model,
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')]
    [string]$ReasoningEffort,
    [string]$ModelDir,
    [int]$Port = 0,
    [string]$Server,
    [switch]$ServerOnly,
    [string]$ApiKeyEnv,
    [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Validate before installing dependencies or touching an existing connection.
$clientOnly = [bool]$Server
if ($clientOnly -and ($ServerOnly -or $Model -or $ModelDir -or $Port -or $ReasoningEffort)) {
    throw 'Client setup accepts -Server; model and port options belong on the server.'
}
if ($Port -lt 0 -or $Port -gt 65535) { throw 'Choose an API port between 1 and 65535, or 0 for the default.' }
if ($Server) {
    $parsedApi = [uri]$Server
    if ($parsedApi.Scheme -notin @('http', 'https') -or -not $parsedApi.Host -or $parsedApi.UserInfo -or
        $parsedApi.Query -or $parsedApi.Fragment -or $parsedApi.AbsolutePath -ne '/' -or $Server -match '\s') {
        throw 'Use an HTTP(S) server address without credentials, path, query, or fragment.'
    }
}
if ($ModelDir) {
    $ModelDir = (Resolve-Path -LiteralPath $ModelDir).Path
    if (-not (Test-Path -LiteralPath (Join-Path $ModelDir 'onnx/model.onnx') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $ModelDir 'tokenizer.json') -PathType Leaf)) {
        throw '-ModelDir must contain onnx/model.onnx and tokenizer.json for multilingual-e5-small.'
    }
}
if ($ApiKeyEnv) {
    $selectedKey = [Environment]::GetEnvironmentVariable($ApiKeyEnv)
    if (-not $selectedKey) { throw 'The selected API-key environment variable is empty.' }
    if ($selectedKey -match '[^\x00-\x7f]|\s') { throw 'Connection key must contain ASCII characters without whitespace.' }
}
if ($env:COPILOT_HOME -and [IO.Path]::GetFullPath($env:COPILOT_HOME).TrimEnd('\', '/') -ne
    [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.copilot')).TrimEnd('\', '/')) {
    throw 'This setup uses the default Copilot profile. Unset COPILOT_HOME before setup.'
}
if (-not $ServerOnly -and -not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'Git must be installed for automatic repository memory selection. Install Git, then rerun setup.'
}
function Invoke-Checked {
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed (exit $LASTEXITCODE)." }
}

$toolsDirectory = Join-Path $PSScriptRoot '.runtime/tools'
New-Item -ItemType Directory -Path $toolsDirectory -Force | Out-Null

try {
    $uvCommand = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $uvCommand) {
        $uvVersion = '0.12.15'
        $uvArchive = Join-Path $toolsDirectory 'uv.zip'
        $uvUrl = "https://github.com/astral-sh/uv/releases/download/$uvVersion/uv-x86_64-pc-windows-msvc.zip"
        Write-Host 'Installing uv...'
        Invoke-WebRequest -Uri $uvUrl -UseBasicParsing -OutFile $uvArchive
        Invoke-WebRequest -Uri ($uvUrl + '.sha256') -UseBasicParsing -OutFile ($uvArchive + '.sha256')
        $expected = ((Get-Content -Raw -LiteralPath ($uvArchive + '.sha256')).Trim() -split '\s+')[0]
        if ((Get-FileHash -LiteralPath $uvArchive -Algorithm SHA256).Hash -ne $expected) { throw 'uv checksum mismatch.' }
        Expand-Archive -LiteralPath $uvArchive -DestinationPath (Join-Path $toolsDirectory 'uv') -Force
        $uvBinary = (Get-ChildItem -LiteralPath (Join-Path $toolsDirectory 'uv') -Filter uv.exe -Recurse | Select-Object -First 1).FullName
    } else { $uvBinary = $uvCommand.Source }
    $env:PATH = (Split-Path -Parent $uvBinary) + ';' + $env:PATH

    $releaseInstall = [bool]$env:HINDSIGHTKIT_RELEASE_MANIFEST
    $nodeVersion = '22.23.2'
    $bundledNodeDirectory = Join-Path $toolsDirectory "node-v$nodeVersion-win-x64"
    $bundledNode = Join-Path $bundledNodeDirectory 'node.exe'
    if ($releaseInstall) {
        # Release commands must survive removal of a previous source checkout.
        $nodeReady = $false
        if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
            $installedNodeVersion = & $bundledNode --version
            $nodeReady = $LASTEXITCODE -eq 0 -and $installedNodeVersion -eq "v$nodeVersion"
        }
    } else {
        $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
        $nodeMajor = if ($nodeCommand) { [int]((& $nodeCommand.Source --version).TrimStart('v').Split('.')[0]) } else { 0 }
        $nodeReady = $nodeMajor -ge 22
    }
    if (-not $nodeReady) {
        # Official portable Node includes npm and needs no administrator installation.
        $archiveName = "node-v$nodeVersion-win-x64.zip"
        $nodeArchive = Join-Path $toolsDirectory $archiveName
        $nodeUrl = "https://nodejs.org/dist/v$nodeVersion"
        Write-Host 'Installing Node.js...'
        Invoke-WebRequest -Uri "$nodeUrl/$archiveName" -UseBasicParsing -OutFile $nodeArchive
        $checksums = (Invoke-WebRequest -Uri "$nodeUrl/SHASUMS256.txt" -UseBasicParsing).Content
        $checksumLine = ($checksums -split '\r?\n' | Where-Object { $_.Trim().EndsWith($archiveName) } | Select-Object -First 1)
        $expected = ($checksumLine.Trim() -split '\s+')[0]
        if ((Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash -ne $expected) { throw 'Node.js checksum mismatch.' }
        Expand-Archive -LiteralPath $nodeArchive -DestinationPath $toolsDirectory -Force
        $installedNodeVersion = & $bundledNode --version
        if ($LASTEXITCODE -ne 0 -or $installedNodeVersion -ne "v$nodeVersion") { throw 'The installed Node.js version does not match the pinned runtime.' }
    }
    if ($releaseInstall -or -not $nodeReady) {
        $env:PATH = $bundledNodeDirectory + ';' + $env:PATH
    }

    $env:UV_CACHE_DIR = Join-Path $PSScriptRoot '.runtime/uv-cache'
    $env:PYTHONUTF8 = '1'
    Write-Host 'Installing the pinned runtime...'
    $syncArgs = @('sync', '--project', $PSScriptRoot, '--python', '3.12', '--frozen')
    # A new release has an empty venv; retain local server management dependencies.
    $serverProfile = Join-Path $env:USERPROFILE '.hindsight/profiles/hindsightkit.env'
    $hadServer = (Test-Path -LiteralPath $serverProfile -PathType Leaf) -or
        (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.venv/Lib/site-packages/hindsight_api') -PathType Container)
    if (-not $clientOnly -or $hadServer) { $syncArgs += @('--extra', 'server') }
    Invoke-Checked $uvBinary $syncArgs
    $commandRoot = if ($env:HINDSIGHTKIT_HOME) { $env:HINDSIGHTKIT_HOME } else { Join-Path $env:USERPROFILE '.hindsightkit' }
    if ($releaseInstall) {
        # prepare_env reads this before selecting Node, so replace any old checkout path.
        New-Item -ItemType Directory -Path $commandRoot -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $commandRoot 'node-path.txt'), $bundledNode, (New-Object Text.UTF8Encoding($false)))
    }
    $python = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
    $setupArgs = @('-m', 'hindsightkit.cli', 'setup')
    if ($Model) { $setupArgs += @('--model', $Model) }
    if ($ReasoningEffort) { $setupArgs += @('--reasoning-effort', $ReasoningEffort) }
    if ($ModelDir) { $setupArgs += @('--model-dir', (Resolve-Path -LiteralPath $ModelDir).Path) }
    if ($Port) { $setupArgs += @('--port', "$Port") }
    if ($Server) { $setupArgs += @('--server', $Server) }
    if ($ServerOnly) { $setupArgs += '--server-only' }
    if ($ApiKeyEnv) { $setupArgs += @('--api-key-env', $ApiKeyEnv) }
    if ($NoOpen) { $setupArgs += '--no-open' }
    # Shell-local aliases and functions are invisible to the Python child's PATH scan.
    $savedHkConflict = $env:HINDSIGHTKIT_HK_CONFLICT
    try {
        $occupied = Get-Command hk -All -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandType -notin @('Application', 'ExternalScript')
        } | Select-Object -First 1
        if ($occupied) { $env:HINDSIGHTKIT_HK_CONFLICT = [string]$occupied.CommandType + ' hk' }
        Invoke-Checked $python $setupArgs
    } finally { $env:HINDSIGHTKIT_HK_CONFLICT = $savedHkConflict }
    $commandDirectory = Join-Path $commandRoot 'bin'
    $env:PATH = $commandDirectory + ';' + (($env:PATH -split ';' | Where-Object { $_ -ne $commandDirectory }) -join ';')
    Invoke-Checked 'hindsightkit' @('--help')
} catch {
    Write-Error $_
    exit 1
}
