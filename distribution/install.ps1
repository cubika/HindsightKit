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

@@INSTALL_OPTIONS@@

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
    foreach ($required in @('setup.ps1', 'pyproject.toml', 'uv.lock', 'release.json', 'src/hindsightkit/cli.py', 'src/hindsightkit/installer.py', 'src/hindsightkit/install_options.ps1')) {
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

function Read-InstallRecord([string]$Path) {
    Assert-InstallDirectory ([IO.Path]::GetDirectoryName($Path)) | Out-Null
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 4MB) {
        throw 'Cannot safely read installation metadata.'
    }
    return [IO.File]::ReadAllText($Path)
}

function Get-InstalledRelease([string]$Path) {
    Assert-InstallDirectory $Path | Out-Null
    $pending = Get-InstallCleanupReceipt $Path
    if (Test-Path -LiteralPath $pending) {
        $record = Read-InstallRecord $pending | ConvertFrom-Json
        if ($record.schema -ne 1 -or $record.Digest -cnotmatch '^[a-f0-9]{64}$' -or
            (Split-Path -Leaf $Path) -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?-[a-f0-9]{12}$' -or
            -not (Split-Path -Leaf $Path).EndsWith('-' + $record.Digest.Substring(0, 12)) -or
            $record.Files -isnot [pscustomobject] -or -not $record.Files.'setup.ps1' -or -not $record.Files.'release.json' -or
            -not $record.Archives -or @($record.Archives | Where-Object { $_ -cnotmatch '^[a-f0-9]{64}\.zip$' }).Count) {
            throw 'Invalid cleanup receipt.'
        }
        return [pscustomobject]@{ Path=$Path; Digest=$record.Digest; Files=$record.Files; Archives=$record.Archives;
            Completed=$null; Created=$null; Started=$false; Pending=$true }
    }
    $digest = (Read-InstallRecord (Join-Path $Path '.package-sha256')).Trim()
    $manifest = Read-InstallRecord (Join-Path $Path 'release.json') | ConvertFrom-Json
    if ($digest -cnotmatch '^[a-f0-9]{64}$' -or $manifest.schema -ne 1 -or
        $manifest.version -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$' -or
        (Split-Path -Leaf $Path) -cne ($manifest.version + '-' + $digest.Substring(0, 12))) {
        throw 'Unrecognized release directory.'
    }
    $files = Read-InstallRecord (Join-Path $Path '.package-files.json') | ConvertFrom-Json
    if ($files -isnot [pscustomobject] -or -not $files.'setup.ps1' -or -not $files.'release.json') {
        throw 'Unrecognized installed file manifest.'
    }
    $archives = @($digest + '.zip')
    foreach ($component in $manifest.components) {
        if ($component.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid installed component digest.' }
        $archives += $component.sha256 + '.zip'
    }
    $completed = $null
    $receipt = Join-Path $Path '.install-success.json'
    if (Test-Path -LiteralPath $receipt) {
        $record = Read-InstallRecord $receipt | ConvertFrom-Json
        if ($record.schema -ne 1 -or $record.package_sha256 -cne $digest) { throw 'Invalid installation receipt.' }
        $completed = [DateTimeOffset]::Parse($record.completed_utc).UtcDateTime
    }
    return [pscustomobject]@{ Path=$Path; Digest=$digest; Files=$files; Archives=$archives; Completed=$completed;
        Created=(Get-Item -LiteralPath $Path).CreationTimeUtc;
        Started=(Test-Path -LiteralPath (Join-Path $Path '.install-started'));
        Pending=$false }
}

function Get-InstallCleanupReceipt([string]$App) {
    $root = Split-Path -Parent (Split-Path -Parent $App)
    return Assert-InstallChild $root (Join-Path $root ('.cleanup-' + (Split-Path -Leaf $App) + '.json'))
}

function ConvertTo-InstallReference([string]$Value) {
    # Match JSON-escaped paths, JSONC, environment variables, and launcher shebangs.
    $decoded = [regex]::Replace($Value, '\\u([0-9a-fA-F]{4})', {
        param($match)
        [string][char][Convert]::ToInt32($match.Groups[1].Value, 16)
    })
    # ExpandEnvironmentVariables stops at NUL on Windows; launcher binaries contain NULs.
    $decoded = $decoded.Replace([string][char]0, '')
    return ([Environment]::ExpandEnvironmentVariables($decoded).Replace('\', '/') -replace '/+', '/').ToLowerInvariant()
}

function Get-InstallReferences {
    $settings = if ($env:HINDSIGHTKIT_HOME) { $env:HINDSIGHTKIT_HOME } else { Join-Path $env:USERPROFILE '.hindsightkit' }
    $official = Join-Path $env:USERPROFILE '.hindsight'
    $config = if ($env:HINDSIGHT_CONFIG) { $env:HINDSIGHT_CONFIG } else { Join-Path $official 'coding-agent.json' }
    $paths = @($config, (Join-Path $official 'profiles/hindsightkit.env'),
        (Join-Path $env:USERPROFILE '.copilot/mcp-config.json'),
        (Join-Path $env:USERPROFILE '.copilot/hooks/hindsight-coding-agents.json'))
    foreach ($relative in @('node-path.txt', 'bin/hindsightkit.exe', 'bin/hk.exe', 'clients.json', 'repositories.json',
            'remote/host/launch.json')) { $paths += Join-Path $settings $relative }
    $clients = Join-Path $settings 'remote/clients'
    if (Test-Path -LiteralPath $clients) {
        Assert-InstallDirectory $clients | Out-Null
        foreach ($client in Get-ChildItem -LiteralPath $clients -Directory -Force) {
            $paths += Join-Path $client.FullName 'launch.json'
        }
    }
    if ($env:APPDATA) {
        foreach ($editor in @('Code', 'Code - Insiders')) {
            $user = Join-Path $env:APPDATA ($editor + '/User')
            $paths += Join-Path $user 'mcp.json'
            $profiles = Join-Path $user 'profiles'
            if (Test-Path -LiteralPath $profiles) {
                Assert-InstallDirectory $profiles | Out-Null
                foreach ($profile in Get-ChildItem -LiteralPath $profiles -Directory -Force) {
                    $paths += Join-Path $profile.FullName 'mcp.json'
                }
            }
        }
    }
    $references = @($settings, $official, $config, $env:PATH, $env:VIRTUAL_ENV)
    foreach ($path in $paths) {
        # The location itself may contain user data inside a release directory.
        $references += [IO.Path]::GetFullPath($path)
        Assert-InstallDirectory ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($path))) | Out-Null
        if (Test-Path -LiteralPath $path) { $references += Read-InstallRecord $path }
    }
    return ConvertTo-InstallReference ($references -join [Environment]::NewLine)
}

function Get-InstallProcessReferences {
    $references = @()
    $processes = @(Get-CimInstance Win32_Process -Property Name, ExecutablePath, CommandLine -OperationTimeoutSec 10 -ErrorAction Stop)
    if (-not $processes.Count) { throw 'Process inspection returned no results.' }
    foreach ($process in $processes) {
        if ($process.Name -match '^(python.*|node|hindsight.*|hk|copilot|powershell|pwsh|cmd)\.exe$' -and
            (-not $process.ExecutablePath -or -not $process.CommandLine)) {
            throw 'Cannot inspect a process that may use an older installation. Close older HindsightKit sessions and rerun the installer to retry cleanup.'
        }
        $references += [string]$process.ExecutablePath
        $references += [string]$process.CommandLine
    }
    return ConvertTo-InstallReference ($references -join [Environment]::NewLine)
}

function Get-InstallTree([string]$Root, [string]$Path) {
    $checked = Assert-InstallChild $Root $Path
    Assert-InstallDirectory $checked | Out-Null
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($checked)
    while ($pending.Count) {
        $directory = $pending.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup found a linked file or directory.' }
            $item
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
}

function Remove-OldInstalledRelease([string]$Root, $Release, $Totals) {
    $path = Assert-InstallChild (Join-Path $Root 'versions') $Release.Path
    $references = (Get-InstallReferences) + [Environment]::NewLine + (Get-InstallProcessReferences)
    if ($references.Contains((ConvertTo-InstallReference $path))) { throw 'Release is still referenced by a process or configuration.' }
    $items = @(Get-InstallTree $Root $path)
    $control = @('.package-sha256', '.package-files.json', 'release.json', '.install-success.json',
        '.install-success.json.tmp', '.install-started')
    $ownedDirectories = @{}
    foreach ($property in $Release.Files.PSObject.Properties) {
        $relative = $property.Name
        while ($relative.Contains('/')) {
            $relative = $relative.Substring(0, $relative.LastIndexOf('/'))
            $ownedDirectories[$relative] = $true
        }
    }
    foreach ($directory in $items | Where-Object PSIsContainer) {
        $relative = $directory.FullName.Substring($path.Length + 1).Replace('\', '/')
        if (-not $ownedDirectories.ContainsKey($relative) -and
            $relative -notmatch '^(\.venv(?:/|$)|\.runtime$|\.runtime/(tools|uv-cache)(?:/|$))') {
            throw 'Release contains directories not owned by the installer.'
        }
    }
    foreach ($file in $items | Where-Object { -not $_.PSIsContainer }) {
        $relative = $file.FullName.Substring($path.Length + 1).Replace('\', '/')
        if ($relative -notin $control -and -not $Release.Files.PSObject.Properties[$relative] -and
            $relative -notmatch '^(\.venv/|\.runtime/(tools|uv-cache)/)') {
            throw 'Release contains files not owned by the installer.'
        }
        # Check locks before removing anything, including lazily imported modules.
        $handle = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        $handle.Dispose()
        if ($Release.Pending -and $Release.Files.PSObject.Properties[$relative] -and
            (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne $Release.Files.$relative) {
            throw 'Installed application files changed during interrupted cleanup.'
        }
    }
    if (-not $Release.Pending) { Assert-InstalledPackage $path }
    $pending = Get-InstallCleanupReceipt $path
    if (-not $Release.Pending) {
        $record = @{ schema=1; Digest=$Release.Digest; Files=$Release.Files; Archives=$Release.Archives } | ConvertTo-Json -Depth 5
        $temporary = $pending + '.tmp'
        if (Test-Path -LiteralPath $temporary) { Read-InstallRecord $temporary | Out-Null }
        [IO.File]::WriteAllText($temporary, $record)
        [IO.File]::Move($temporary, $pending)
    }
    # The external receipt survives an interruption, even during metadata deletion.
    foreach ($file in $items | Where-Object { -not $_.PSIsContainer -and $_.FullName.Substring($path.Length + 1) -notin $control }) {
        Remove-Item -LiteralPath $file.FullName -Force
        $Totals.Bytes += $file.Length
    }
    foreach ($directory in $items | Where-Object PSIsContainer | Sort-Object { $_.FullName.Length } -Descending) {
        [IO.Directory]::Delete($directory.FullName)
    }
    foreach ($name in $control) {
        $file = Join-Path $path $name
        if (Test-Path -LiteralPath $file) {
            $size = (Get-Item -LiteralPath $file -Force).Length
            Remove-Item -LiteralPath $file -Force
            $Totals.Bytes += $size
        }
    }
    [IO.Directory]::Delete($path)
    $Totals.Versions++
    Remove-Item -LiteralPath $pending -Force
}

function Invoke-InstallRetention([string]$Root, [string]$App) {
    # Called only after setup's runtime, launcher, and memory checks succeed, under install.lock.
    $totals = @{ Bytes=[long]0; Versions=0; Files=0 }
    try {
        $current = Get-InstalledRelease $App
        $receipt = Join-Path $App '.install-success.json'
        $temporary = $receipt + '.tmp'
        foreach ($file in @($receipt, $temporary)) { if (Test-Path -LiteralPath $file) { Read-InstallRecord $file | Out-Null } }
        $record = @{ schema=1; package_sha256=$current.Digest; completed_utc=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json
        [IO.File]::WriteAllText($temporary, $record)
        if (Test-Path -LiteralPath $receipt) { [IO.File]::Replace($temporary, $receipt, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $receipt) }
        if ($current.Pending) { Remove-Item -LiteralPath (Get-InstallCleanupReceipt $App) -Force }
        $versions = Assert-InstallDirectory (Join-Path $Root 'versions')
        $releases = @()
        $cacheSafe = $true
        foreach ($pending in Get-ChildItem -LiteralPath $Root -Filter '.cleanup-*.json' -File -Force) {
            try {
                $name = $pending.Name.Substring(9, $pending.Name.Length - 14)
                $path = Assert-InstallChild $versions (Join-Path $versions $name)
                if (-not (Test-Path -LiteralPath $path)) {
                    # Validate the receipt before removing an orphan left after directory deletion.
                    Get-InstalledRelease $path | Out-Null
                    Remove-Item -LiteralPath $pending.FullName -Force
                }
            } catch { $cacheSafe = $false }
        }
        foreach ($directory in Get-ChildItem -LiteralPath $versions -Directory -Force) {
            try { $releases += Get-InstalledRelease $directory.FullName }
            catch { $cacheSafe = $false }
        }
        $previous = $releases | Where-Object { $_.Path -ne $App -and $_.Completed -and -not $_.Pending } |
            Sort-Object Completed -Descending | Select-Object -First 1
        if (-not $previous) {
            # Keep one legacy copy when upgrading from installers without success receipts.
            $previous = $releases | Where-Object { $_.Path -ne $App -and -not $_.Started -and -not $_.Pending } |
                Sort-Object Created -Descending | Select-Object -First 1
        }
        foreach ($release in $releases) {
            if ($release.Path -eq $App -or $release.Path -eq $previous.Path -or
                ($release.Started -and -not $release.Completed)) { continue }
            try { Remove-OldInstalledRelease $Root $release $totals }
            catch { Write-InstallMessage ('Kept older release ' + (Split-Path -Leaf $release.Path) + ': ' + $_.Exception.Message) }
        }
        $archives = @{}
        foreach ($release in $releases) {
            if (Test-Path -LiteralPath $release.Path) { foreach ($archive in $release.Archives) { $archives[$archive] = $true } }
        }
        foreach ($name in @('downloads', 'logs')) {
            $directory = Assert-InstallDirectory (Join-Path $Root $name)
            if (-not (Test-Path -LiteralPath $directory)) { continue }
            foreach ($file in Get-ChildItem -LiteralPath $directory -File -Force) {
                if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
                if ($name -eq 'downloads') {
                    # Leave recent failed downloads available for retries.
                    if (-not $cacheSafe -or $file.Name -cnotmatch '^[a-f0-9]{64}\.zip(?:\.partial)?$' -or
                        $archives.ContainsKey(($file.Name -replace '\.partial$', '')) -or
                        $file.LastWriteTimeUtc -ge [DateTime]::UtcNow.AddDays(-7)) { continue }
                } elseif ($file.Name -cnotmatch '^install-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}\.log$' -or
                    $file.FullName -eq $script:installLog -or $file.LastWriteTimeUtc -ge [DateTime]::UtcNow.AddDays(-30)) { continue }
                try {
                    $checked = Assert-InstallChild $Root $file.FullName
                    Remove-Item -LiteralPath $checked -Force
                    $totals.Bytes += $file.Length
                    $totals.Files++
                } catch { Write-InstallMessage 'An old cache or log file is in use; cleanup will retry after a later installation.' }
            }
        }
    } catch { Write-InstallMessage ('Installation cleanup deferred: ' + $_.Exception.Message) }
    Write-InstallMessage ('Cleanup: removed {0} older version(s), {1} cache/log file(s), {2:N1} MiB of files. Kept current and previous successful versions and any protected releases.' -f
        $totals.Versions, $totals.Files, ($totals.Bytes / 1MB))
}

function Install-HindsightKit([System.Collections.IDictionary]$Options) {
    if ($releaseVersion.StartsWith('@@')) { throw 'Use install.ps1 from a published release. This file is a packaging template.' }
    if ($env:OS -ne 'Windows_NT' -or ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64')) { throw 'HindsightKit requires x64 Windows.' }
    $installationMode = Resolve-InstallMode $Options
    Assert-InstallOptions $Options $installationMode
    $clientInstall = $installationMode -eq 'client-only'
    if ($installationMode -eq 'server-only') { $ServerOnly = $true }
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
        $started = Join-Path $app '.install-started'
        if (-not (Test-Path -LiteralPath $started)) { [IO.File]::WriteAllText($started, $packageSha256) }
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
        Invoke-InstallRetention $root $app
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
