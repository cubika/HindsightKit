#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$ServerOnly,
    [switch]$ClientOnly,
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
$clientPackageName = '@@CLIENT_PACKAGE_NAME@@'
$clientPackageSha256 = '@@CLIENT_PACKAGE_SHA256@@'
$releaseRepository = '@@REPOSITORY@@'
$requiresAuth = @@REQUIRES_AUTH@@
$installLog = $null

function Write-InstallMessage([string]$Message) {
    Write-Host $Message
    if ($script:installLog) {
        [IO.File]::AppendAllText($script:installLog, $Message + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    }
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

function Protect-InstallLogs([string]$Directory) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Directory /inheritance:r /grant:r ("*" + $sid + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE) { throw 'Cannot restrict installation log access.' }
}

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

function Assert-ReleaseFile([string]$Name) {
    if (-not $Name -or $Name.Contains('\') -or $Name -match '[<>:"|?*\x00-\x1f]') { throw "Invalid release package entry: $Name" }
    foreach ($part in $Name.Split('/')) {
        if (-not $part -or $part -in @('.', '..') -or $part.TrimEnd(' ', '.') -ne $part -or
            $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw "Invalid release package entry: $Name" }
    }
}

function Expand-InstallFiles([IO.Stream]$Stream, [string]$Destination, $ExpectedFiles = $null) {
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $Stream.Position = 0
    $zip = New-Object IO.Compression.ZipArchive($Stream, [IO.Compression.ZipArchiveMode]::Read, $true)
    $seen = @{}
    $hashes = [ordered]@{}
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            if (-not $name.StartsWith('app/', [StringComparison]::Ordinal) -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw "Invalid release package entry: $name" }
            $relative = $name.Substring(4)
            Assert-ReleaseFile $relative
            if ($seen.ContainsKey($relative)) { throw "Duplicate release package entry: $name" }
            $seen[$relative] = $true
            if ($null -ne $ExpectedFiles -and -not $ExpectedFiles.Contains($relative)) { throw "Unexpected component file: $relative" }
        }
        if ($null -ne $ExpectedFiles -and $seen.Count -ne $ExpectedFiles.Count) { throw 'Dependency component is missing files.' }
        foreach ($entry in $zip.Entries) {
            $relative = $entry.FullName.Substring(4)
            $target = Assert-InstallChild $Destination (Join-Path $Destination $relative)
            $parent = Assert-InstallDirectory ([IO.Path]::GetDirectoryName($target))
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
            if ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Extracted application files must not be links.'
            }
            $hashes[$relative] = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
            if ($null -ne $ExpectedFiles -and $hashes[$relative] -ne $ExpectedFiles[$relative]) { throw "Component file SHA256 mismatch: $relative" }
        }
    } finally { $zip.Dispose() }
    return $hashes
}

function Expand-InstallPackage([IO.Stream]$Archive, [string]$Destination) {
    $hashes = Expand-InstallFiles $Archive $Destination
    foreach ($required in @('setup.ps1', 'pyproject.toml', 'uv.lock', 'release.json', 'src/hindsightkit/cli.py', 'src/hindsightkit/installer.py')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Destination $required) -PathType Leaf)) { throw "Release package is missing $required" }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $Destination 'release.json') -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or $manifest.version -ne $releaseVersion -or $manifest.release_url -ne $releaseUrl) {
        throw 'Release package metadata does not match this installer.'
    }
    [IO.File]::WriteAllText((Join-Path $Destination '.package-files.json'), ($hashes | ConvertTo-Json))
}

function Open-VerifiedAsset([string]$Root, [string]$Asset, [string]$Digest) {
    if ($Asset -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*\.zip$' -or $Digest -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Invalid release asset identity.'
    }
    $cache = Assert-InstallDirectory (Join-Path $Root 'downloads')
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $cached = Assert-InstallChild $cache (Join-Path $cache ($Digest + '.zip'))
    $partial = Assert-InstallChild $cache ($cached + '.partial')
    foreach ($path in @($cached, $partial)) {
        if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).PSIsContainer -or
            ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint))) {
            throw 'Download cache files must be ordinary files.'
        }
    }
    if (Test-Path -LiteralPath $cached) {
        # Hold the same handle through hashing and extraction. FileShare.Read
        # prevents writes and replacement while these verified bytes are used.
        $stream = [IO.File]::Open($cached, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        catch { $stream.Dispose(); throw }
        finally { $sha.Dispose() }
        if ($actual -eq $Digest) {
            $stream.Position = 0
            Write-InstallMessage "Reusing verified download: $Asset"
            return ,$stream
        }
        $stream.Dispose()
        Write-InstallMessage "Cached download changed; downloading again: $Asset"
        Remove-Item -LiteralPath $cached -Force
    }
    Write-InstallMessage "Downloading $Asset..."
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            if ($requiresAuth) {
                $releaseHost = ([uri]$releaseUrl).Host
                & gh release download $releaseVersion --repo ($releaseHost + '/' + $releaseRepository) --pattern $Asset --output $partial --clobber
                if ($LASTEXITCODE) { throw 'Authenticated release download failed. Check gh auth status and repository access.' }
            } else {
                Invoke-WebRequest -Uri ($releaseUrl + '/' + $Asset) -OutFile $partial -UseBasicParsing -TimeoutSec 900
            }
            break
        } catch { if ($attempt -eq 3) { throw }; Write-InstallMessage 'Download failed; retrying.' }
    }
    # The installer owns the cache lock. Rename before verification so the same
    # read-only handle remains valid until the caller finishes extraction.
    [IO.File]::Move($partial, $cached)
    $stream = [IO.File]::Open($cached, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    catch { $stream.Dispose(); throw }
    finally { $sha.Dispose() }
    if ($actual -ne $Digest) {
        $stream.Dispose()
        Remove-Item -LiteralPath $cached -Force
        throw 'HindsightKit package SHA256 mismatch. Installation stopped.'
    }
    $stream.Position = 0
    return ,$stream
}

function Install-ReleaseComponents([string]$Root, [string]$App) {
    $release = Get-Content -LiteralPath (Join-Path $App 'release.json') -Raw | ConvertFrom-Json
    $required = if ($release.package_role -eq 'client') { @('python-client', 'node-client') }
        elseif ($release.package_role -eq 'full') { @('python-client', 'python-server', 'node-client', 'node-server') }
        else { throw 'Unknown release package role.' }
    $names = @{}
    $allFiles = [ordered]@{}
    $saved = Get-Content -LiteralPath (Join-Path $App '.package-files.json') -Raw | ConvertFrom-Json
    foreach ($property in $saved.PSObject.Properties) { $allFiles[$property.Name] = $property.Value }
    # Validate the whole plan before downloading or writing any dependencies.
    foreach ($component in $release.components) {
        if ($component.name -notin $required -or $names.ContainsKey($component.name) -or
            $component.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            $component.asset -cne ('hindsightkit-' + $component.name + '-' + $component.sha256 + '.zip')) {
            throw 'Invalid dependency component identity.'
        }
        $names[$component.name] = $true
        if ($component.files -isnot [pscustomobject]) { throw 'Dependency component files must be a mapping.' }
        foreach ($property in $component.files.PSObject.Properties) {
            Assert-ReleaseFile $property.Name
            $allowed = if ($component.name.StartsWith('python-')) {
                $property.Name -cmatch '^python/wheels/[A-Za-z0-9_.+-]+\.whl$' -and
                $property.Name -notmatch '^python/wheels/hindsightkit-'
            }
                else { $property.Name -ceq ('node/' + $component.name.Substring(5) + '.zip') }
            if (-not $allowed -or $property.Value -cnotmatch '^[a-f0-9]{64}$' -or $allFiles.Contains($property.Name)) {
                throw 'Invalid or duplicate dependency component file.'
            }
            $allFiles[$property.Name] = $property.Value
        }
        if ($component.name.StartsWith('node-') -and @($component.files.PSObject.Properties).Count -ne 1) {
            throw 'Node dependency component is missing its archive.'
        }
    }
    if ($names.Count -ne $required.Count) { throw 'Release dependency components are incomplete.' }
    foreach ($component in $release.components) {
        $expected = [ordered]@{}
        foreach ($property in $component.files.PSObject.Properties) { $expected[$property.Name] = $property.Value }
        $stream = Open-VerifiedAsset $Root $component.asset $component.sha256
        try { Expand-InstallFiles $stream $App $expected | Out-Null }
        finally { $stream.Dispose() }
        Write-InstallMessage ('Prepared ' + $component.name + '.')
    }
    [IO.File]::WriteAllText((Join-Path $App '.package-files.json'), ($allFiles | ConvertTo-Json))
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

function Install-HindsightKit([System.Collections.IDictionary]$Options) {
    if ($releaseVersion.StartsWith('@@')) { throw 'Use install.ps1 from a published release. This file is a packaging template.' }
    if ($env:OS -ne 'Windows_NT' -or ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64')) { throw 'HindsightKit requires x64 Windows.' }
    $installationMode = Resolve-InstallMode $Options
    $clientInstall = $installationMode -eq 'client-only'
    if ($installationMode -eq 'server-only') { $ServerOnly = $true }
    if ($ServerOnly -and $clientInstall) { throw 'ServerOnly and client-only options cannot be combined.' }
    if ($clientInstall -and ($Model -or $ModelDir -or $Port -or $ReasoningEffort)) { throw 'Model and port options belong on the server.' }
    if ($clientInstall -and $ApiKeyEnv -and -not $Server) { throw '-ApiKeyEnv requires -Server during client-only installation.' }
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
    if ($requiresAuth -and -not (Get-Command gh -CommandType Application -ErrorAction SilentlyContinue)) { throw 'Install GitHub CLI and run gh auth login with an account that can read this repository.' }
    $root = Assert-InstallDirectory $InstallDir
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $logDirectory = Assert-InstallDirectory (Join-Path $root 'logs')
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    Protect-InstallLogs $logDirectory
    $script:installLog = Join-Path $logDirectory ('install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.log')
    Write-InstallMessage ("HindsightKit " + $releaseVersion + " installation. Log: " + $script:installLog)
    $lockPath = Join-Path $root 'install.lock'
    if ((Test-Path -LiteralPath $lockPath) -and ((Get-Item -LiteralPath $lockPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation lock must not be a link.' }
    try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'Another HindsightKit installation is running, or the installation directory is not writable.' }
    $stage = $null
    try {
        $existingServer = Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.hindsight/profiles/hindsightkit.env') -PathType Leaf
        if ($clientInstall -and -not $existingServer) {
            $packageName = $clientPackageName
            $packageSha256 = $clientPackageSha256
            Write-InstallMessage 'Client package selected: no UI, database, or local model dependencies.'
        } elseif ($clientInstall) {
            Write-InstallMessage 'Existing local server detected. Keeping its management dependencies; only client setup will run.'
        }
        $versionRoot = Assert-InstallDirectory (Join-Path $root 'versions')
        New-Item -ItemType Directory -Path $versionRoot -Force | Out-Null
        $app = Assert-InstallDirectory (Join-Path $versionRoot ($releaseVersion + '-' + $packageSha256.Substring(0, 12)))
        if (-not (Test-Path -LiteralPath $app)) {
            $stage = Join-Path $root ('.install-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $stage | Out-Null
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            $unpacked = Join-Path $stage 'app'
            New-Item -ItemType Directory -Path $unpacked | Out-Null
            $archive = Open-VerifiedAsset $root $packageName $packageSha256
            try { Expand-InstallPackage $archive $unpacked }
            finally { $archive.Dispose() }
            Install-ReleaseComponents $root $unpacked
            [IO.File]::WriteAllText((Join-Path $unpacked '.package-sha256'), $packageSha256)
            [IO.Directory]::Move($unpacked, $app)
            Write-InstallMessage 'Application package extracted.'
        } elseif (-not (Test-Path -LiteralPath (Join-Path $app '.package-sha256')) -or
            (Get-Content -LiteralPath (Join-Path $app '.package-sha256') -Raw) -ne $packageSha256) {
            throw 'Existing release directory is not owned by this installer. Its files were preserved.'
        } else {
            # Fresh extraction already checked every file and recorded its hash.
            # A retry must check the saved files before executing setup again.
            Assert-InstalledPackage $app
        }
        Write-InstallMessage ("Using verified application: " + $app)
        $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $app 'setup.ps1'))
        if ($ServerOnly) { $arguments += '-ServerOnly' }
        if ($clientInstall) { $arguments += '-ClientOnly' }
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
        $previousInstallLog = $env:HINDSIGHTKIT_INSTALL_LOG
        $previousInstallMode = $env:HINDSIGHTKIT_INSTALL_MODE
        $previousInstallCache = $env:HINDSIGHTKIT_INSTALL_CACHE
        try {
            # Windows PowerShell -File cannot forward a switch with a false value.
            $env:HINDSIGHTKIT_INSTALL_MODE = $installationMode
            $env:HINDSIGHTKIT_RELEASE_MANIFEST = Join-Path $app 'release.json'
            $env:HINDSIGHTKIT_INSTALL_LOG = $script:installLog
            $env:UV_PYTHON_INSTALL_DIR = Join-Path $root 'python'
            $env:UV_PYTHON_PREFERENCE = 'only-managed'
            $env:HINDSIGHTKIT_INSTALL_CACHE = Assert-InstallDirectory (Join-Path $root 'cache')
            $env:PSModulePath = $null
            $occupied = Get-Command hk -All -ErrorAction SilentlyContinue | Where-Object {
                $_.CommandType -notin @('Application', 'ExternalScript')
            } | Select-Object -First 1
            if ($occupied) { $env:HINDSIGHTKIT_HK_CONFLICT = [string]$occupied.CommandType + ' hk' }
            Write-InstallMessage 'Preparing runtimes and configuring HindsightKit...'
            & powershell.exe @arguments
            if ($LASTEXITCODE -ne 0) { throw "Setup stopped (exit $LASTEXITCODE). See the first error above and log: $script:installLog" }
        } finally {
            $env:HINDSIGHTKIT_RELEASE_MANIFEST = $previousManifest
            $env:UV_PYTHON_INSTALL_DIR = $previousPython
            $env:UV_PYTHON_PREFERENCE = $previousPreference
            $env:PSModulePath = $previousModulePath
            $env:HINDSIGHTKIT_HK_CONFLICT = $previousHkConflict
            $env:HINDSIGHTKIT_INSTALL_LOG = $previousInstallLog
            $env:HINDSIGHTKIT_INSTALL_MODE = $previousInstallMode
            $env:HINDSIGHTKIT_INSTALL_CACHE = $previousInstallCache
        }
        $commandRoot = if ($env:HINDSIGHTKIT_HOME) { $env:HINDSIGHTKIT_HOME } else { Join-Path $env:USERPROFILE '.hindsightkit' }
        $commandDirectory = Join-Path $commandRoot 'bin'
        $env:PATH = $commandDirectory + ';' + (($env:PATH -split ';' | Where-Object { $_ -ne $commandDirectory }) -join ';')
        Write-InstallMessage "HindsightKit $releaseVersion installed successfully."
        if ($clientInstall -and -not $Server) {
            Write-Host 'Client is ready. Use hindsightkit connect to choose a server; existing connections are preserved.'
        } elseif (-not $ServerOnly) {
            Write-Host 'Reload VS Code and open a new Copilot CLI session.'
        }
    } finally {
        try { if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-InstallStage $root $stage } }
        finally { $lock.Dispose() }
    }
}

try {
    Install-HindsightKit $PSBoundParameters
} catch {
    $message = 'HindsightKit installation failed: ' + $_.Exception.Message
    if ($script:installLog) {
        [IO.File]::AppendAllText($script:installLog, $message + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    }
    Write-Host $message -ForegroundColor Red
    throw $message
}
