#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$ServerOnly,
    [string]$Server,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'HindsightKit'),
    [string]$Model,
    [string]$ReasoningEffort,
    [string]$ModelDir,
    [int]$Port = 0,
    [string]$ApiKeyEnv,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Filled when packaging a release in the destination repository.
$releaseVersion = '@@VERSION@@'
$releaseUrl = '@@RELEASE_URL@@'
$packageName = '@@PACKAGE_NAME@@'
$packageSha256 = '@@PACKAGE_SHA256@@'

function Assert-InstallDirectory([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path)) { throw 'InstallDir must be an absolute path.' }
    $absolute = [IO.Path]::GetFullPath($Path).TrimEnd([char[]]'\/')
    if ($absolute -eq [IO.Path]::GetPathRoot($absolute).TrimEnd([char[]]'\/')) { throw 'A drive root cannot be an installation directory.' }
    for ($ancestor = $absolute; $ancestor; $ancestor = [IO.Path]::GetDirectoryName($ancestor)) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "Installation paths must contain ordinary directories: $ancestor"
            }
        }
    }
    return $absolute
}

function Assert-InstallChild([string]$Parent, [string]$Child) {
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
    $absolute = [IO.Path]::GetFullPath($Child)
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Package path escapes the installation directory.' }
    return $absolute
}

function Expand-InstallPackage([string]$Archive, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    $seen = @{}
    $hashes = [ordered]@{}
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            if (-not $name.StartsWith('app/', [StringComparison]::Ordinal) -or $name.Contains('\') -or
                $name.Contains(':') -or $name -match '(^|/)\.{1,2}(/|$)' -or $name -match '[\x00-\x1f]' -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw "Invalid release package entry: $name" }
            $relative = $name.Substring(4)
            if (-not $relative -or $relative.EndsWith('/')) { continue }
            if ($seen.ContainsKey($relative)) { throw "Duplicate release package entry: $name" }
            $seen[$relative] = $true
            $target = Assert-InstallChild $Destination (Join-Path $Destination $relative)
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
            $hashes[$relative] = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
        }
    } finally { $zip.Dispose() }
    foreach ($required in @('setup.ps1', 'pyproject.toml', 'uv.lock', 'release.json', 'src/hindsightkit/cli.py')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Destination $required) -PathType Leaf)) { throw "Release package is missing $required" }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $Destination 'release.json') -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or $manifest.version -ne $releaseVersion -or $manifest.release_url -ne $releaseUrl) {
        throw 'Release package metadata does not match this installer.'
    }
    [IO.File]::WriteAllText((Join-Path $Destination '.package-files.json'), ($hashes | ConvertTo-Json))
}

function Assert-InstalledPackage([string]$App) {
    $manifestPath = Join-Path $App '.package-files.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Installed package manifest is missing. Use a new InstallDir; existing files were preserved.' }
    $files = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($property in $files.PSObject.Properties) {
        $path = Assert-InstallChild $App (Join-Path $App $property.Name)
        Assert-InstallDirectory ([IO.Path]::GetDirectoryName($path)) | Out-Null
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
            ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $property.Value) {
            throw 'Installed application files changed or are missing. Use a new InstallDir; existing files were preserved.'
        }
    }
}

function Remove-InstallStage([string]$Root, [string]$Stage) {
    $checked = Assert-InstallChild $Root $Stage
    if ((Split-Path -Leaf $checked) -notmatch '^\.install-[a-f0-9]{32}$') { throw 'Unexpected installation staging directory.' }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($checked)
    while ($pending.Count) {
        $directory = $pending.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to clean a staging directory containing links.' }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
    Assert-InstallDirectory $checked | Out-Null
    Remove-Item -LiteralPath $checked -Recurse -Force
}

function Install-HindsightKit {
    if ($releaseVersion.StartsWith('@@')) { throw 'Use install.ps1 from a published release. This file is a packaging template.' }
    if ($env:OS -ne 'Windows_NT' -or ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64')) { throw 'HindsightKit requires x64 Windows.' }
    if ($ServerOnly -and $Server) { throw 'ServerOnly and Server cannot be combined.' }
    if ($Server -and ($Model -or $ModelDir -or $Port -or $ReasoningEffort)) { throw 'Model and port options belong on the server.' }
    if ($ReasoningEffort -and $ReasoningEffort -notin @('low', 'medium', 'high', 'xhigh', 'max')) { throw 'Unknown reasoning effort.' }
    if ($Port -lt 0 -or $Port -gt 65535) { throw 'Choose an API port between 1 and 65535, or 0 for the default.' }
    if ($Server) {
        $parsedServer = [uri]$Server
        if ($parsedServer.Scheme -notin @('http', 'https') -or -not $parsedServer.Host -or $parsedServer.UserInfo -or
            $parsedServer.Query -or $parsedServer.Fragment -or $parsedServer.AbsolutePath -ne '/' -or $Server -match '\s') {
            throw 'Use an HTTP(S) server address without credentials, path, query, or fragment.'
        }
    }
    if (-not $ServerOnly -and -not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) { throw 'Install Git before installing coding integrations.' }
    $root = Assert-InstallDirectory $InstallDir
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $lockPath = Join-Path $root 'install.lock'
    if ((Test-Path -LiteralPath $lockPath) -and ((Get-Item -LiteralPath $lockPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation lock must not be a link.' }
    try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'Another HindsightKit installation is running, or the installation directory is not writable.' }
    $stage = $null
    try {
        $versionRoot = Assert-InstallDirectory (Join-Path $root 'versions')
        New-Item -ItemType Directory -Path $versionRoot -Force | Out-Null
        $app = Assert-InstallDirectory (Join-Path $versionRoot ($releaseVersion + '-' + $packageSha256.Substring(0, 12)))
        if (-not (Test-Path -LiteralPath $app)) {
            $stage = Join-Path $root ('.install-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $stage | Out-Null
            $archive = Join-Path $stage 'package.zip'
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            Write-Host "Downloading HindsightKit $releaseVersion..."
            for ($attempt = 1; $attempt -le 3; $attempt++) {
                try {
                    Invoke-WebRequest -Uri ($releaseUrl + '/' + $packageName) -OutFile $archive -UseBasicParsing -TimeoutSec 900
                    break
                } catch { if ($attempt -eq 3) { throw }; Write-Warning 'Download failed; retrying.' }
            }
            if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $packageSha256) { throw 'HindsightKit package SHA256 mismatch. Installation stopped.' }
            $unpacked = Join-Path $stage 'app'
            New-Item -ItemType Directory -Path $unpacked | Out-Null
            Expand-InstallPackage $archive $unpacked
            [IO.File]::WriteAllText((Join-Path $unpacked '.package-sha256'), $packageSha256)
            [IO.Directory]::Move($unpacked, $app)
        } elseif (-not (Test-Path -LiteralPath (Join-Path $app '.package-sha256')) -or
            (Get-Content -LiteralPath (Join-Path $app '.package-sha256') -Raw) -ne $packageSha256) {
            throw 'Existing release directory is not owned by this installer. Its files were preserved.'
        }
        Assert-InstalledPackage $app
        $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $app 'setup.ps1'))
        if ($ServerOnly) { $arguments += '-ServerOnly' }
        if ($Server) { $arguments += @('-Server', $Server) }
        if ($Model) { $arguments += @('-Model', $Model) }
        if ($ReasoningEffort) { $arguments += @('-ReasoningEffort', $ReasoningEffort) }
        if ($ModelDir) { $arguments += @('-ModelDir', (Resolve-Path -LiteralPath $ModelDir).Path) }
        if ($Port) { $arguments += @('-Port', [string]$Port) }
        if ($ApiKeyEnv) { $arguments += @('-ApiKeyEnv', $ApiKeyEnv) }
        if ($NoOpen) { $arguments += '-NoOpen' }
        $previousManifest = $env:HINDSIGHTKIT_RELEASE_MANIFEST
        $previousPython = $env:UV_PYTHON_INSTALL_DIR
        $previousPreference = $env:UV_PYTHON_PREFERENCE
        $previousModulePath = $env:PSModulePath
        $previousHkConflict = $env:HINDSIGHTKIT_HK_CONFLICT
        try {
            $env:HINDSIGHTKIT_RELEASE_MANIFEST = Join-Path $app 'release.json'
            $env:UV_PYTHON_INSTALL_DIR = Join-Path $root 'python'
            $env:UV_PYTHON_PREFERENCE = 'only-managed'
            $env:PSModulePath = $null
            $occupied = Get-Command hk -All -ErrorAction SilentlyContinue | Where-Object {
                $_.CommandType -notin @('Application', 'ExternalScript')
            } | Select-Object -First 1
            if ($occupied) { $env:HINDSIGHTKIT_HK_CONFLICT = [string]$occupied.CommandType + ' hk' }
            Write-Host "Installing into $app"
            & powershell.exe @arguments
            if ($LASTEXITCODE -ne 0) { throw "Setup failed (exit $LASTEXITCODE). Rerun this installer to retry; existing data was preserved." }
        } finally {
            $env:HINDSIGHTKIT_RELEASE_MANIFEST = $previousManifest
            $env:UV_PYTHON_INSTALL_DIR = $previousPython
            $env:UV_PYTHON_PREFERENCE = $previousPreference
            $env:PSModulePath = $previousModulePath
            $env:HINDSIGHTKIT_HK_CONFLICT = $previousHkConflict
        }
        $commandRoot = if ($env:HINDSIGHTKIT_HOME) { $env:HINDSIGHTKIT_HOME } else { Join-Path $env:USERPROFILE '.hindsightkit' }
        $commandDirectory = Join-Path $commandRoot 'bin'
        $env:PATH = $commandDirectory + ';' + (($env:PATH -split ';' | Where-Object { $_ -ne $commandDirectory }) -join ';')
        Write-Host "HindsightKit $releaseVersion installed."
        if (-not $ServerOnly) { Write-Host 'Reload VS Code and open a new Copilot CLI session.' }
    } finally {
        try { if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-InstallStage $root $stage } }
        finally { $lock.Dispose() }
    }
}

Install-HindsightKit
