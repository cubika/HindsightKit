[CmdletBinding()]
param(
    [string]$Project = (Get-Location).Path,
    [string]$Model,
    [string]$ModelDir,
    [int]$Port = 0,
    [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Invoke-Checked {
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed (exit $LASTEXITCODE)." }
}

$projectPath = (Resolve-Path -LiteralPath $Project).Path
$toolsDirectory = Join-Path $PSScriptRoot '.runtime/tools'
New-Item -ItemType Directory -Path $toolsDirectory -Force | Out-Null

try {
    $uvCommand = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $uvCommand) {
        $uvVersion = '0.12.15'
        $uvArchive = Join-Path $toolsDirectory 'uv.zip'
        $uvUrl = "https://github.com/astral-sh/uv/releases/download/$uvVersion/uv-x86_64-pc-windows-msvc.zip"
        Write-Host 'Installing uv...'
        Invoke-WebRequest -Uri $uvUrl -OutFile $uvArchive
        Invoke-WebRequest -Uri ($uvUrl + '.sha256') -OutFile ($uvArchive + '.sha256')
        $expected = ((Get-Content -Raw -LiteralPath ($uvArchive + '.sha256')).Trim() -split '\s+')[0]
        if ((Get-FileHash -LiteralPath $uvArchive -Algorithm SHA256).Hash -ne $expected) { throw 'uv checksum mismatch.' }
        Expand-Archive -LiteralPath $uvArchive -DestinationPath (Join-Path $toolsDirectory 'uv') -Force
        $uvBinary = (Get-ChildItem -LiteralPath (Join-Path $toolsDirectory 'uv') -Filter uv.exe -Recurse | Select-Object -First 1).FullName
    } else { $uvBinary = $uvCommand.Source }
    $env:PATH = (Split-Path -Parent $uvBinary) + ';' + $env:PATH

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $nodeMajor = if ($nodeCommand) { [int]((& $nodeCommand.Source --version).TrimStart('v').Split('.')[0]) } else { 0 }
    if ($nodeMajor -lt 22) {
        # Official portable Node includes npm and needs no administrator installation.
        $nodeVersion = '22.23.2'
        $archiveName = "node-v$nodeVersion-win-x64.zip"
        $nodeArchive = Join-Path $toolsDirectory $archiveName
        $nodeUrl = "https://nodejs.org/dist/v$nodeVersion"
        Write-Host 'Installing Node.js...'
        Invoke-WebRequest -Uri "$nodeUrl/$archiveName" -OutFile $nodeArchive
        $checksums = (Invoke-WebRequest -Uri "$nodeUrl/SHASUMS256.txt").Content
        $checksumLine = ($checksums -split '\r?\n' | Where-Object { $_.Trim().EndsWith($archiveName) } | Select-Object -First 1)
        $expected = ($checksumLine.Trim() -split '\s+')[0]
        if ((Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash -ne $expected) { throw 'Node.js checksum mismatch.' }
        Expand-Archive -LiteralPath $nodeArchive -DestinationPath $toolsDirectory -Force
        $env:PATH = (Join-Path $toolsDirectory "node-v$nodeVersion-win-x64") + ';' + $env:PATH
    }

    $env:UV_CACHE_DIR = Join-Path $PSScriptRoot '.runtime/uv-cache'
    $env:PYTHONUTF8 = '1'
    Write-Host 'Installing the pinned Hindsight runtime...'
    Invoke-Checked $uvBinary @('sync', '--project', $PSScriptRoot, '--python', '3.12', '--frozen')
    $python = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
    $setupArgs = @('-m', 'provenloop.cli', 'setup', '--project', $projectPath)
    if ($Model) { $setupArgs += @('--model', $Model) }
    if ($ModelDir) { $setupArgs += @('--model-dir', (Resolve-Path -LiteralPath $ModelDir).Path) }
    if ($Port) { $setupArgs += @('--port', "$Port") }
    if ($NoOpen) { $setupArgs += '--no-open' }
    Invoke-Checked $python $setupArgs
} catch {
    Write-Error $_
    exit 1
}
