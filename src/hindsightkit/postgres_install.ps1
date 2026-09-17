#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$CacheDirectory,
    [string]$DistributionUrl,
    [string]$DistributionSha256,
    [string]$ReleaseRepository,
    [string]$ReleaseTag
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$PostgresVersion = '18.6'
$VectorVersion = '0.8.6'
$PostgresUrl = 'https://get.enterprisedb.com/postgresql/postgresql-18.6-1-windows-x64-binaries.zip'
$PostgresSha256 = 'FBE23DA234EE31547BF8A36D29DFD81E82B849DF2D2B78D2EECB43D360252F8C'
$VectorUrl = 'https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.6.zip'
$VectorSha256 = 'E93A1567219C9CE523CA16473F6C41CC80E01345B2D91CCDEE40B473B7C5DD0A'
$ManifestName = 'hindsightkit-postgres.json'
$RequiredExtensions = @('vector', 'pg_trgm', 'btree_gin', 'btree_gist', 'pg_stat_statements', 'unaccent', 'pgcrypto', 'uuid-ossp')

function Get-AbsoluteDirectory([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path)) { throw "An absolute directory is required: $Path" }
    if ($Path -match '[%!\r\n]') { throw 'Installation and cache paths cannot contain percent signs, exclamation marks, or newlines; the official Windows build uses cmd.exe.' }
    $absolute = [IO.Path]::GetFullPath($Path).TrimEnd([char[]]'\/')
    if ($absolute -eq [IO.Path]::GetPathRoot($absolute).TrimEnd([char[]]'\/')) {
        throw 'A drive root cannot be used as an installation or cache directory.'
    }
    $ancestor = $absolute
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "Directory ancestors must be ordinary directories: $ancestor"
            }
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    return $absolute
}

function Assert-ChildPath([string]$Parent, [string]$Child) {
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
    $absolute = [IO.Path]::GetFullPath($Child)
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path escapes the expected directory: $absolute"
    }
    return $absolute
}

function Get-Sha256([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Expected an ordinary file: $Path"
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Assert-OrdinaryTree([string]$Root) {
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Root)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        $item = Get-Item -LiteralPath $directory -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing a directory tree containing a reparse point: $directory" }
        foreach ($child in Get-ChildItem -LiteralPath $directory -Force) {
            if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing a directory tree containing a reparse point: $($child.FullName)" }
            if ($child.PSIsContainer) { $pending.Push($child.FullName) }
        }
    }
}

function Get-VerifiedArchive([string]$Url, [string]$Name, [string]$Sha256,
    [string]$Repository, [string]$Tag, [string]$Asset) {
    $cached = Assert-ChildPath $CacheDirectory (Join-Path $CacheDirectory $Name)
    if (Test-Path -LiteralPath $cached) {
        if ((Get-Sha256 $cached) -eq $Sha256) { return $cached }
        $quarantine = Assert-ChildPath $CacheDirectory ($cached + '.invalid-' + [guid]::NewGuid().ToString('N'))
        Move-Item -LiteralPath $cached -Destination $quarantine
        Write-Warning "Cached archive failed SHA256 verification; retained at $quarantine"
    }
    $partial = Assert-ChildPath $CacheDirectory ($cached + '.part-' + [guid]::NewGuid().ToString('N'))
    try {
        Write-Host "Downloading $Name..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            try {
                if ($Repository) {
                    $gh = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue
                    if (-not $gh) { throw 'GitHub CLI is required to download this release. Install gh and sign in to the release host, then rerun setup.' }
                    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial }
                    # gh owns the current account and its credentials. Suppress
                    # subprocess diagnostics, which can include authenticated URLs.
                    try {
                        & $gh.Source release download $Tag --repo $Repository --pattern $Asset --output $partial *> $null
                        $downloadExit = $LASTEXITCODE
                    } catch { $downloadExit = 1 }
                    if ($downloadExit -ne 0) { throw "Authenticated release download failed (exit $downloadExit). Check gh authentication and access to $Repository, then rerun setup." }
                } else {
                    Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing -TimeoutSec 900
                }
                break
            } catch {
                if ($attempt -eq 3) { throw }
                Write-Warning "Download attempt $attempt failed for $Name; retrying."
                Start-Sleep -Seconds (2 * $attempt)
            }
        }
        if ((Get-Sha256 $partial) -ne $Sha256) {
            throw "SHA256 verification failed for $Name. The downloaded file was not used."
        }
        if (Test-Path -LiteralPath $cached) {
            if ((Get-Sha256 $cached) -ne $Sha256) { throw "Cache changed during download: $cached" }
        } else {
            Move-Item -LiteralPath $partial -Destination $cached
        }
        return $cached
    } finally {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial }
    }
}

function Assert-MicrosoftSignature([string]$Path) {
    $signature = Get-AuthenticodeSignature -FilePath $Path
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)') {
        throw "A valid Microsoft signature is required: $Path (status: $($signature.Status))"
    }
}

function Find-CppTools {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { return $null }
    $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -ne 0) { throw 'Visual Studio tool discovery failed.' }
    if (-not $installation) { return $null }
    $installation = [string](@($installation)[0])
    if (Test-Path -LiteralPath (Join-Path $installation 'VC\Auxiliary\Build\vcvars64.bat') -PathType Leaf) {
        return $installation
    }
    return $null
}

function Get-CppTools {
    $installation = Find-CppTools
    if ($installation) { return $installation }
    $installer = Assert-ChildPath $CacheDirectory (Join-Path $CacheDirectory ('vs-buildtools-' + [guid]::NewGuid().ToString('N') + '.exe'))
    try {
        Write-Host 'Installing the Microsoft C++ build tools needed to compile official pgvector sources. Windows may request administrator approval.'
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vs_BuildTools.exe' -OutFile $installer -UseBasicParsing
        Assert-MicrosoftSignature $installer
        $arguments = @('--quiet', '--wait', '--norestart', '--nocache', '--add', 'Microsoft.VisualStudio.Workload.VCTools', '--includeRecommended')
        try {
            $process = Start-Process -FilePath $installer -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
        } catch {
            throw "Microsoft C++ build tools installation did not start. Approve its Windows UAC prompt or install the Desktop development with C++ workload and rerun setup. $($_.Exception.Message)"
        }
        if ($process.ExitCode -notin @(0, 3010)) {
            throw "Microsoft C++ build tools installation failed (exit $($process.ExitCode)). Rerun setup after resolving the Visual Studio installer error."
        }
        if ($process.ExitCode -eq 3010) { Write-Warning 'Microsoft C++ build tools requested a restart. If compilation fails, restart Windows and rerun setup.' }
        $installation = Find-CppTools
        if (-not $installation) { throw 'Microsoft C++ build tools were not found after installation. Restart Windows if requested, then rerun setup.' }
        return $installation
    } finally {
        if (Test-Path -LiteralPath $installer) { Remove-Item -LiteralPath $installer }
    }
}

function Expand-OfficialArchive([string]$Archive, [string]$Root, [string]$Prefix, [string[]]$Directories) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $zip.Entries) {
            if (-not $entry.FullName.StartsWith($Prefix, [StringComparison]::Ordinal)) {
                throw "Unexpected archive root: $($entry.FullName)"
            }
            $relative = $entry.FullName.Substring($Prefix.Length)
            if ($relative -match '[\\:]' -or @($relative.TrimEnd('/').Split('/') | Where-Object { $_ -in @('.', '..') }).Count -gt 0 -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000 -or
                ($entry.ExternalAttributes -band [int][IO.FileAttributes]::ReparsePoint)) {
                throw "Unsafe archive entry: $($entry.FullName)"
            }
            if (-not $relative -or $relative.EndsWith('/')) { continue }
            if ($Directories.Count -gt 0 -and $relative.Contains('/') -and $relative.Split('/')[0] -notin $Directories) { continue }
            $target = Assert-ChildPath $Root (Join-Path $Root $relative)
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
        }
    } finally { $zip.Dispose() }
}

function Install-CppRuntime([string]$Installation, [string]$PgRoot) {
    $redistRoot = Join-Path $Installation 'VC\Redist\MSVC'
    $versionDirectories = @(Get-ChildItem -LiteralPath $redistRoot -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending)
    $runtime = $null
    foreach ($directory in $versionDirectories) {
        $x64 = Join-Path $directory.FullName 'x64'
        if (Test-Path -LiteralPath $x64 -PathType Container) {
            $candidate = @(Get-ChildItem -LiteralPath $x64 -Directory | Where-Object { $_.Name -match '^Microsoft\.VC\d+\.CRT$' })
            if ($candidate.Count -gt 0) { $runtime = $candidate[0].FullName; break }
        }
    }
    if (-not $runtime) { throw 'The Microsoft C++ x64 redistributable files are missing. Repair the Visual Studio C++ workload and rerun setup.' }
    foreach ($file in Get-ChildItem -LiteralPath $runtime -Filter '*.dll' -File) {
        Assert-MicrosoftSignature $file.FullName
        Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $PgRoot 'bin')
    }
    return [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $PgRoot 'bin\vcruntime140.dll')).FileVersion
}

function Build-Vector([string]$Installation, [string]$PgRoot, [string]$SourceRoot, [string]$StageRoot) {
    $batch = Assert-ChildPath $StageRoot (Join-Path $StageRoot 'build-vector.cmd')
    [IO.File]::WriteAllText($batch, "@echo off`r`ncall `"%HINDSIGHTKIT_VCVARS%`" >nul`r`nif errorlevel 1 exit /b %errorlevel%`r`nnmake /NOLOGO /F Makefile.win`r`nif errorlevel 1 exit /b %errorlevel%`r`nnmake /NOLOGO /F Makefile.win install`r`nexit /b %errorlevel%`r`n", [Text.Encoding]::ASCII)
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $env:ComSpec
    $start.Arguments = '/d /v:off /s /c ""' + $batch + '""'
    $start.WorkingDirectory = $SourceRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['PGROOT'] = $PgRoot
    $start.EnvironmentVariables['HINDSIGHTKIT_VCVARS'] = Join-Path $Installation 'VC\Auxiliary\Build\vcvars64.bat'
    # MSVC expands header __FILE__ macros to absolute paths. Apply its path map
    # through the compiler environment while keeping the official Makefile intact.
    $pathOptions = '/experimental:deterministic /pathmap:"' + $StageRoot + '=."'
    $start.EnvironmentVariables['_CL_'] = (($start.EnvironmentVariables['_CL_'] + ' ' + $pathOptions).Trim())
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    Write-Host "Compiling pgvector $VectorVersion against PostgreSQL $PostgresVersion with Microsoft C++..."
    try {
        if (-not $process.Start()) { throw 'Could not start the pgvector compiler.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $output = $stdoutTask.GetAwaiter().GetResult() + $stderrTask.GetAwaiter().GetResult()
        $buildLog = Assert-ChildPath $CacheDirectory (Join-Path $CacheDirectory ('pgvector-build-' + [guid]::NewGuid().ToString('N') + '.log'))
        [IO.File]::WriteAllText($buildLog, $output, (New-Object Text.UTF8Encoding($false)))
        if ($process.ExitCode -ne 0) { throw "pgvector compilation failed (exit $($process.ExitCode)). Build log: $buildLog" }
        Write-Host "pgvector build succeeded. Build log: $buildLog"
    } finally { $process.Dispose() }
}

function Assert-Distribution([string]$Root, [bool]$VerifyManifest) {
    Assert-OrdinaryTree $Root
    foreach ($directory in @('bin', 'lib', 'share', 'include')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $directory) -PathType Container)) { throw "PostgreSQL directory is missing: $directory" }
    }
    $required = @('bin/postgres.exe', 'bin/initdb.exe', 'bin/pg_ctl.exe', 'bin/pg_isready.exe', 'bin/psql.exe', 'bin/pg_dump.exe', 'bin/pg_dumpall.exe', 'bin/pg_restore.exe', 'bin/pg_config.exe', 'bin/vcruntime140.dll', 'lib/postgres.lib', 'include/server/postgres.h', "share/extension/vector--$VectorVersion.sql")
    foreach ($extension in $RequiredExtensions) { $required += @("lib/$extension.dll", "share/extension/$extension.control") }
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) { throw "Required PostgreSQL file is missing: $relative" }
    }
    if ($VerifyManifest) {
        $manifestFile = Join-Path $Root $ManifestName
        if (-not (Test-Path -LiteralPath $manifestFile -PathType Leaf)) { throw "Refusing an existing PostgreSQL directory without $ManifestName. Choose a new destination." }
        $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
        if ($manifest.schema -ne 1 -or $manifest.postgres_version -ne $PostgresVersion -or $manifest.vector_version -ne $VectorVersion -or
            $manifest.architecture -ne 'windows-x64' -or $manifest.postgres_sha256 -ne $PostgresSha256 -or $manifest.vector_sha256 -ne $VectorSha256) {
            throw 'Existing PostgreSQL installation differs from the pinned distribution. Choose a new destination; existing files were preserved.'
        }
        foreach ($relative in $required) {
            if ($null -eq $manifest.files.PSObject.Properties[$relative]) { throw "Installed file is absent from the distribution manifest: $relative" }
        }
        foreach ($file in Get-ChildItem -LiteralPath $Root -File -Recurse -Force) {
            $relative = $file.FullName.Substring($Root.Length + 1).Replace('\', '/')
            if ($relative -ne $ManifestName -and $null -eq $manifest.files.PSObject.Properties[$relative]) {
                throw "Installed file is absent from the distribution manifest: $relative"
            }
        }
        foreach ($property in $manifest.files.PSObject.Properties) {
            if ($property.Name -match '[\\:]' -or @($property.Name.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0 -or
                $property.Value -notmatch '^[a-fA-F0-9]{64}$') { throw 'The distribution manifest contains an invalid file entry.' }
            $path = Assert-ChildPath $Root (Join-Path $Root $property.Name)
            if ((Get-Sha256 $path) -ne $property.Value) { throw "Installed file failed SHA256 verification: $($property.Name). Existing files were preserved." }
        }
    }
    $version = & (Join-Path $Root 'bin\postgres.exe') --version
    if ($LASTEXITCODE -ne 0 -or [string]$version -notmatch ('^postgres \(PostgreSQL\) ' + [regex]::Escape($PostgresVersion) + '$')) {
        throw "Expected PostgreSQL $PostgresVersion, got: $version"
    }
    $vectorControl = Get-Content -LiteralPath (Join-Path $Root 'share\extension\vector.control') -Raw
    if ($vectorControl -notmatch ("(?m)^default_version\s*=\s*'" + [regex]::Escape($VectorVersion) + "'\s*$")) { throw "Expected pgvector $VectorVersion." }
}

function Write-DistributionManifest([string]$Root, [string]$RuntimeVersion) {
    $files = [ordered]@{}
    foreach ($file in Get-ChildItem -LiteralPath $Root -File -Recurse | Sort-Object FullName) {
        $relative = $file.FullName.Substring($Root.Length + 1).Replace('\', '/')
        $files[$relative] = Get-Sha256 $file.FullName
    }
    $extensions = [ordered]@{}
    foreach ($extension in $RequiredExtensions) {
        $control = Get-Content -LiteralPath (Join-Path $Root "share/extension/$extension.control") -Raw
        if ($control -notmatch "(?m)^default_version\s*=\s*'([^']+)'") { throw "Extension version is missing: $extension" }
        $extensions[$extension] = $Matches[1]
    }
    $manifest = [ordered]@{
        schema = 1
        postgres_version = $PostgresVersion
        vector_version = $VectorVersion
        architecture = 'windows-x64'
        postgres_url = $PostgresUrl
        postgres_sha256 = $PostgresSha256
        vector_url = $VectorUrl
        vector_sha256 = $VectorSha256
        msvc_runtime_version = $RuntimeVersion
        extensions = $extensions
        files = $files
    }
    [IO.File]::WriteAllText((Join-Path $Root $ManifestName), ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
}

if ($env:OS -ne 'Windows_NT' -or ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64')) {
    throw 'This installer requires x64 Windows.'
}
$useDistribution = $PSBoundParameters.ContainsKey('DistributionUrl') -or $PSBoundParameters.ContainsKey('DistributionSha256')
$useReleaseAuth = $PSBoundParameters.ContainsKey('ReleaseRepository') -or $PSBoundParameters.ContainsKey('ReleaseTag')
$downloadRepository = $null
$downloadAsset = $null
if ($useReleaseAuth -and -not $useDistribution) { throw 'Authenticated release options require a distribution URL and SHA256.' }
if ($useDistribution) {
    $parsedDistribution = $null
    if (-not [uri]::TryCreate($DistributionUrl, [UriKind]::Absolute, [ref]$parsedDistribution) -or
        $parsedDistribution.Scheme -ne 'https' -or -not $parsedDistribution.Host -or $parsedDistribution.UserInfo -or
        $parsedDistribution.Fragment -or $DistributionUrl -match '\s' -or $DistributionSha256 -notmatch '^[a-fA-F0-9]{64}$') {
        throw 'A release distribution requires an HTTPS URL without credentials or a fragment and a valid SHA256.'
    }
    if ($useReleaseAuth) {
        $downloadAsset = $parsedDistribution.Segments[-1]
        $expectedPath = '/' + $ReleaseRepository + '/releases/download/' + $ReleaseTag + '/' + $downloadAsset
        if ($ReleaseRepository -notmatch '^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$' -or
            $ReleaseTag -notmatch '^v\d+\.\d+\.\d+(?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$' -or
            $downloadAsset -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*\.zip$' -or $parsedDistribution.Query -or
            $DistributionUrl -cne ('https://' + $parsedDistribution.Authority + $expectedPath)) {
            throw 'The authenticated distribution URL must match its repository, release tag and ZIP asset.'
        }
        $downloadRepository = $parsedDistribution.Authority + '/' + $ReleaseRepository
    }
}
$Destination = Get-AbsoluteDirectory $Destination
$CacheDirectory = Get-AbsoluteDirectory $CacheDirectory
if ($Destination.Equals($CacheDirectory, [StringComparison]::OrdinalIgnoreCase) -or
    $CacheDirectory.StartsWith($Destination + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The cache must be outside the PostgreSQL installation directory.'
}
if (Test-Path -LiteralPath $Destination) {
    Assert-Distribution $Destination $true
    Write-Host "Verified existing PostgreSQL $PostgresVersion and pgvector $VectorVersion."
} else {
    New-Item -ItemType Directory -Path $CacheDirectory -Force | Out-Null
    $parent = [IO.Path]::GetDirectoryName($Destination)
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $stageRoot = Assert-ChildPath $parent (Join-Path $parent ('.hindsightkit-postgres-' + [guid]::NewGuid().ToString('N')))
    New-Item -ItemType Directory -Path $stageRoot | Out-Null
    try {
        $pgRoot = Join-Path $stageRoot 'pgsql'
        if ($useDistribution) {
            $archiveName = 'hindsightkit-postgres-' + $DistributionSha256.ToLowerInvariant() + '.zip'
            $archive = Get-VerifiedArchive $DistributionUrl $archiveName $DistributionSha256 $downloadRepository $ReleaseTag $downloadAsset
            Write-Host 'Extracting the precompiled PostgreSQL release and pgvector...'
            Expand-OfficialArchive $archive $pgRoot 'pgsql/' @()
        } else {
            $postgresArchive = Get-VerifiedArchive $PostgresUrl 'postgresql-18.6-1-windows-x64-binaries.zip' $PostgresSha256
            $vectorArchive = Get-VerifiedArchive $VectorUrl 'pgvector-v0.8.6.zip' $VectorSha256
            $installation = Get-CppTools
            $sourceRoot = Join-Path $stageRoot 'pgvector'
            Write-Host 'Extracting the official PostgreSQL server, client tools, headers, libraries, and all bundled extensions...'
            Expand-OfficialArchive $postgresArchive $pgRoot 'pgsql/' @('bin', 'lib', 'share', 'include', 'doc')
            Expand-OfficialArchive $vectorArchive $sourceRoot 'pgvector-0.8.6/' @()
            $runtimeVersion = Install-CppRuntime $installation $pgRoot
            Build-Vector $installation $pgRoot $sourceRoot $stageRoot
            Copy-Item -LiteralPath (Join-Path $sourceRoot 'LICENSE') -Destination (Join-Path $pgRoot 'share\extension\vector-LICENSE')
            Assert-Distribution $pgRoot $false
            Write-DistributionManifest $pgRoot $runtimeVersion
        }
        Write-Host 'Verifying the PostgreSQL distribution and all file checksums...'
        Assert-Distribution $pgRoot $true
        if (Test-Path -LiteralPath $Destination) { throw 'Destination appeared while preparing PostgreSQL. Existing files were preserved; rerun setup.' }
        [IO.Directory]::Move($pgRoot, $Destination)
        Write-Host "Installed PostgreSQL $PostgresVersion and pgvector $VectorVersion."
    } finally {
        if (Test-Path -LiteralPath $stageRoot) {
            $checkedStage = Assert-ChildPath $parent $stageRoot
            if ((Split-Path -Leaf $checkedStage) -notmatch '^\.hindsightkit-postgres-[a-f0-9]{32}$') { throw 'Refusing to clean an unexpected staging path.' }
            Assert-OrdinaryTree $checkedStage
            Remove-Item -LiteralPath $checkedStage -Recurse -Force
        }
    }
}
[ordered]@{ destination = $Destination; postgres_version = $PostgresVersion; vector_version = $VectorVersion; manifest = (Join-Path $Destination $ManifestName) } | ConvertTo-Json -Compress
