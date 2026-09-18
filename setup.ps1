[CmdletBinding()]
param(
    [string]$Model,
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')]
    [string]$ReasoningEffort,
    [string]$ModelDir,
    [int]$Port = 0,
    [string]$Server,
    [switch]$ServerOnly,
    [switch]$ClientOnly,
    [string]$ApiKeyEnv,
    [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = 'Validate installation options'

try {
function Add-InstallLog([string]$Message) {
    if ($env:HINDSIGHTKIT_INSTALL_LOG) {
        [IO.File]::AppendAllText($env:HINDSIGHTKIT_INSTALL_LOG, $Message + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    }
}

function Write-InstallStatus([string]$Message) {
    Write-Host $Message
    Add-InstallLog $Message
}

function Resolve-InstallMode([System.Collections.IDictionary]$Options) {
    if ($Options['Server'] -or $Options['ClientOnly']) { return 'client-only' }
    if ($Options['ServerOnly']) { return 'server-only' }
    if ($Options.ContainsKey('ClientOnly')) { return 'full' }
    # The release bootstrap has already resolved defaults before selecting an archive.
    if ($env:HINDSIGHTKIT_INSTALL_MODE -in @('client-only', 'server-only', 'full')) {
        return $env:HINDSIGHTKIT_INSTALL_MODE
    }
    $settings = if ($env:HINDSIGHTKIT_HOME) { $env:HINDSIGHTKIT_HOME } else { Join-Path $env:USERPROFILE '.hindsightkit' }
    $record = Join-Path $settings 'installation.json'
    if (Test-Path -LiteralPath $record -PathType Leaf) {
        $installed = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
        if ($installed.schema -ne 1 -or $installed.mode -notin @('client-only', 'server-only', 'full')) {
            throw 'Invalid installation mode record. Rerun with -ClientOnly or -ClientOnly:$false to select the installation role.'
        }
        return $installed.mode
    }
    $profile = Join-Path $env:USERPROFILE '.hindsight/profiles/hindsightkit.env'
    $config = if ($env:HINDSIGHT_CONFIG) { $env:HINDSIGHT_CONFIG } else { Join-Path $env:USERPROFILE '.hindsight/coding-agent.json' }
    if (-not (Test-Path -LiteralPath $profile -PathType Leaf) -and
        ((Test-Path -LiteralPath (Join-Path $settings 'client-runtime/.installed-lock') -PathType Leaf) -or
         (Test-Path -LiteralPath $config -PathType Leaf))) {
        return 'client-only'
    }
    return 'full'
}

# Validate before installing dependencies or touching an existing connection.
$installationMode = Resolve-InstallMode $PSBoundParameters
$clientOnly = $installationMode -eq 'client-only'
if ($installationMode -eq 'server-only') { $ServerOnly = $true }
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
    if ($clientOnly -and -not $Server) { throw '-ApiKeyEnv requires -Server during client-only installation.' }
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
    param([string]$File, [string[]]$Arguments, [switch]$Capture, [switch]$PrivateOutput)
    if ($PrivateOutput) {
        # Preserve the console for Copilot's interactive login and key prompts.
        # Its output is intentionally excluded from the installation log.
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$(Split-Path -Leaf $File) failed (exit $LASTEXITCODE)." }
        return
    }
    $firstError = $null
    $invocationFailed = $false
    $captured = New-Object 'System.Collections.Generic.List[string]'
    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell represents native stderr as ErrorRecord objects.
        # Stream it without converting an informational stderr line into a failure.
        $ErrorActionPreference = 'Continue'
        & $File @Arguments 2>&1 | ForEach-Object {
            $line = [string]$_
            if ($_ -is [Management.Automation.ErrorRecord] -and $_.FullyQualifiedErrorId -notlike 'NativeCommand*') {
                $invocationFailed = $true
            }
            if (-not $firstError -and $line -match '(?i)error:|caused by:|failed|exception|fatal:') { $firstError = $line.Trim() }
            Add-InstallLog $line
            if ($Capture) { $captured.Add($line) } else { Write-Host $line }
        }
        $code = $LASTEXITCODE
        if ($invocationFailed -and (-not $code)) { $code = 1 }
    } finally { $ErrorActionPreference = $previousPreference }
    if ($code -ne 0) {
        $detail = if ($firstError) { ' ' + $firstError } else { '' }
        throw "$(Split-Path -Leaf $File) failed (exit $code).$detail"
    }
    if ($Capture) { return ($captured -join [Environment]::NewLine).Trim() }
}

function Get-UsableNode([string]$Binary, [string]$RequiredVersion) {
    if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) { return }
    $npm = Join-Path (Split-Path -Parent $Binary) 'node_modules/npm/bin/npm-cli.js'
    if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
        Write-InstallStatus "Skipping Node.js at ${Binary}: npm is missing."
        return
    }
    try { $version = Invoke-Checked $Binary @('--version') -Capture } catch {
        Write-InstallStatus "Skipping Node.js at ${Binary}: version check failed."
        return
    }
    if ($version -notmatch '^v([0-9]+)\.[0-9]+\.[0-9]+$' -or [int]$Matches[1] -lt 22) {
        Write-InstallStatus "Skipping Node.js at ${Binary}: Node.js 22+ is required (found $version)."
        return
    }
    if ($RequiredVersion -and $version -ne "v$RequiredVersion") { return }
    try { $architecture = Invoke-Checked $Binary @('-p', 'process.arch') -Capture } catch { return }
    if ($architecture -ne 'x64') {
        Write-InstallStatus "Skipping Node.js at ${Binary}: an x64 runtime is required (found $architecture)."
        return
    }
    return [pscustomobject]@{ Binary = [IO.Path]::GetFullPath($Binary); Version = $version }
}

$releaseInstall = [bool]$env:HINDSIGHTKIT_RELEASE_MANIFEST
$serverProfile = Join-Path $env:USERPROFILE '.hindsight/profiles/hindsightkit.env'
$hadServer = (Test-Path -LiteralPath $serverProfile -PathType Leaf) -or
    (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.venv/Lib/site-packages/hindsight_api') -PathType Container)
$needsServer = -not $clientOnly -or $hadServer
$pythonBundle = Join-Path $PSScriptRoot 'python'
$wheels = Join-Path $pythonBundle 'wheels'
if ($releaseInstall) {
    $requiredProfiles = if ($needsServer) { @('requirements-client.txt', 'requirements-server.txt') } else { @('requirements-client.txt') }
    foreach ($required in $requiredProfiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $pythonBundle $required) -PathType Leaf)) {
            throw "The release Python bundle is missing $required. Download a complete release; setup will not use PyPI."
        }
    }
    if (-not (Test-Path -LiteralPath $wheels -PathType Container) -or
        -not (Get-ChildItem -LiteralPath $wheels -Filter '*.whl' -File | Select-Object -First 1)) {
        throw 'The release Python wheel bundle is missing or empty. Download a complete release; setup will not use PyPI.'
    }
}
Write-InstallStatus 'Installation options validated.'
if ($clientOnly) {
    Write-InstallStatus 'Client-only installation: no local dashboard, database, or model will be installed or started.'
    if ($hadServer) { Write-InstallStatus 'Existing local server detected: preserving its management dependencies and data. Client setup will not reconfigure it.' }
}
$toolsDirectory = Join-Path $PSScriptRoot '.runtime/tools'
New-Item -ItemType Directory -Path $toolsDirectory -Force | Out-Null

    $stage = 'Prepare uv'
    Write-InstallStatus "Starting: $stage"
    $uvCommand = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $uvCommand) {
        $uvVersion = '0.12.15'
        $uvArchive = Join-Path $toolsDirectory 'uv.zip'
        $uvUrl = "https://github.com/astral-sh/uv/releases/download/$uvVersion/uv-x86_64-pc-windows-msvc.zip"
        Write-InstallStatus "Downloading uv $uvVersion to $uvArchive"
        Invoke-WebRequest -Uri $uvUrl -UseBasicParsing -OutFile $uvArchive
        Invoke-WebRequest -Uri ($uvUrl + '.sha256') -UseBasicParsing -OutFile ($uvArchive + '.sha256')
        $expected = ((Get-Content -Raw -LiteralPath ($uvArchive + '.sha256')).Trim() -split '\s+')[0]
        if ((Get-FileHash -LiteralPath $uvArchive -Algorithm SHA256).Hash -ne $expected) { throw 'uv checksum mismatch.' }
        Expand-Archive -LiteralPath $uvArchive -DestinationPath (Join-Path $toolsDirectory 'uv') -Force
        $uvBinary = (Get-ChildItem -LiteralPath (Join-Path $toolsDirectory 'uv') -Filter uv.exe -Recurse | Select-Object -First 1).FullName
        $uvAction = 'Installed'
    } else { $uvBinary = $uvCommand.Source; $uvAction = 'Reusing' }
    $actualUvVersion = Invoke-Checked $uvBinary @('--version') -Capture
    if ($actualUvVersion -notmatch '^uv [0-9]+\.[0-9]+\.[0-9]+') { throw 'The selected uv executable did not report a valid version.' }
    Write-InstallStatus "$uvAction $actualUvVersion at $uvBinary"
    $env:PATH = (Split-Path -Parent $uvBinary) + ';' + $env:PATH
    Write-InstallStatus 'Completed: Prepare uv'

    $stage = 'Prepare Node.js'
    Write-InstallStatus "Starting: $stage"
    $nodeVersion = '22.23.2'
    $bundledNodeDirectory = Join-Path $toolsDirectory "node-v$nodeVersion-win-x64"
    $bundledNode = Join-Path $bundledNodeDirectory 'node.exe'
    $selectedNode = $null
    foreach ($candidate in @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue)) {
        if ($releaseInstall -and $candidate.Source -match '^(.*)[\\/]\.runtime[\\/]tools[\\/]node-[^\\/]+[\\/]node.exe$' -and
            (Test-Path -LiteralPath (Join-Path $Matches[1] 'setup.ps1')) -and
            (Test-Path -LiteralPath (Join-Path $Matches[1] 'pyproject.toml'))) {
            # A release must survive removal of an old checkout or version directory.
            continue
        }
        $selectedNode = Get-UsableNode $candidate.Source
        if ($selectedNode) { break }
    }
    if (-not $selectedNode) { $selectedNode = Get-UsableNode $bundledNode $nodeVersion }
    if (-not $selectedNode) {
        # Official portable Node includes npm and needs no administrator installation.
        $archiveName = "node-v$nodeVersion-win-x64.zip"
        $nodeArchive = Join-Path $toolsDirectory $archiveName
        $nodeUrl = "https://nodejs.org/dist/v$nodeVersion"
        Write-InstallStatus "Downloading Node.js $nodeVersion to $nodeArchive"
        Invoke-WebRequest -Uri "$nodeUrl/$archiveName" -UseBasicParsing -OutFile $nodeArchive
        $checksums = (Invoke-WebRequest -Uri "$nodeUrl/SHASUMS256.txt" -UseBasicParsing).Content
        $checksumLine = ($checksums -split '\r?\n' | Where-Object { $_.Trim().EndsWith($archiveName) } | Select-Object -First 1)
        $expected = ($checksumLine.Trim() -split '\s+')[0]
        if ((Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash -ne $expected) { throw 'Node.js checksum mismatch.' }
        Expand-Archive -LiteralPath $nodeArchive -DestinationPath $toolsDirectory -Force
        $selectedNode = Get-UsableNode $bundledNode $nodeVersion
        if (-not $selectedNode) { throw 'The installed Node.js must match the pinned runtime and include npm.' }
        Write-InstallStatus "Installed Node.js $($selectedNode.Version) at $($selectedNode.Binary)"
    } else {
        Write-InstallStatus "Reusing Node.js $($selectedNode.Version) at $($selectedNode.Binary)"
    }
    $env:PATH = (Split-Path -Parent $selectedNode.Binary) + ';' + $env:PATH
    Write-InstallStatus 'Completed: Prepare Node.js'

    $env:UV_CACHE_DIR = Join-Path $PSScriptRoot '.runtime/uv-cache'
    $env:PYTHONUTF8 = '1'
    # A new release has an empty venv; retain local server management dependencies.
    $python = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
    if ($releaseInstall) {
        $stage = 'Prepare Python 3.12'
        Write-InstallStatus "Starting: $stage"
        $venv = Join-Path $PSScriptRoot '.venv'
        $existingVenv = Test-Path -LiteralPath $venv
        if ($existingVenv -and -not (Test-Path -LiteralPath $python -PathType Leaf)) {
            throw 'The existing Python environment is incomplete. Use a new InstallDir; existing files were preserved.'
        }
        if (-not $existingVenv) {
            Write-InstallStatus "Creating Python 3.12 environment at $venv"
            Invoke-Checked $uvBinary @('venv', $venv, '--python', '3.12')
        }
        $actualPythonVersion = Invoke-Checked $python @('--version') -Capture
        if ($actualPythonVersion -notmatch '^Python 3\.12\.[0-9]+$') {
            throw "The environment requires Python 3.12; found $actualPythonVersion. Use a new InstallDir; existing files were preserved."
        }
        $pythonAction = if ($existingVenv) { 'Reusing' } else { 'Installed' }
        Write-InstallStatus "$pythonAction $actualPythonVersion at $python"
        Write-InstallStatus 'Completed: Prepare Python 3.12'
        $stage = 'Install bundled Python packages'
        Write-InstallStatus "Starting: $stage"
        $requirements = Join-Path $pythonBundle $(if ($needsServer) { 'requirements-server.txt' } else { 'requirements-client.txt' })
        Invoke-Checked $uvBinary @('pip', 'sync', '--python', $python, '--offline', '--no-index',
            '--find-links', $wheels, '--require-hashes', '--only-binary', ':all:', $requirements)
    } else {
        $stage = 'Install locked Python packages'
        Write-InstallStatus "Starting: $stage"
        $syncArgs = @('sync', '--project', $PSScriptRoot, '--python', '3.12', '--frozen')
        if ($needsServer) { $syncArgs += @('--extra', 'server') }
        Invoke-Checked $uvBinary $syncArgs
    }
    Write-InstallStatus "Completed: $stage"
    $commandRoot = if ($env:HINDSIGHTKIT_HOME) { $env:HINDSIGHTKIT_HOME } else { Join-Path $env:USERPROFILE '.hindsightkit' }
    # prepare_env reads this before selecting Node; keep the choice from this run.
    New-Item -ItemType Directory -Path $commandRoot -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $commandRoot 'node-path.txt'), $selectedNode.Binary, (New-Object Text.UTF8Encoding($false)))
    $stage = if ($clientOnly) { 'Configure client integrations' } else { 'Configure HindsightKit and verify memory' }
    Write-InstallStatus "Starting: $stage"
    $setupArgs = @('-m', 'hindsightkit.installer')
    if ($Model) { $setupArgs += @('--model', $Model) }
    if ($ReasoningEffort) { $setupArgs += @('--reasoning-effort', $ReasoningEffort) }
    if ($ModelDir) { $setupArgs += @('--model-dir', (Resolve-Path -LiteralPath $ModelDir).Path) }
    if ($Port) { $setupArgs += @('--port', "$Port") }
    if ($Server) { $setupArgs += @('--server', $Server) }
    if ($ServerOnly) { $setupArgs += '--server-only' }
    if ($clientOnly) { $setupArgs += '--client-only' }
    if ($ApiKeyEnv) { $setupArgs += @('--api-key-env', $ApiKeyEnv) }
    if ($NoOpen) { $setupArgs += '--no-open' }
    # Shell-local aliases and functions are invisible to the Python child's PATH scan.
    $savedHkConflict = $env:HINDSIGHTKIT_HK_CONFLICT
    try {
        $occupied = Get-Command hk -All -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandType -notin @('Application', 'ExternalScript')
        } | Select-Object -First 1
        if ($occupied) { $env:HINDSIGHTKIT_HK_CONFLICT = [string]$occupied.CommandType + ' hk' }
        Invoke-Checked $python $setupArgs -PrivateOutput
    } finally { $env:HINDSIGHTKIT_HK_CONFLICT = $savedHkConflict }
    Write-InstallStatus "Completed: $stage"
    $commandDirectory = Join-Path $commandRoot 'bin'
    $env:PATH = $commandDirectory + ';' + (($env:PATH -split ';' | Where-Object { $_ -ne $commandDirectory }) -join ';')
} catch {
    $summary = "HindsightKit setup failed during ${stage}: $($_.Exception.Message)"
    [Console]::Error.WriteLine($summary)
    Add-InstallLog $summary
    exit 1
}
