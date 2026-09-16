param(
    [string]$Version = "0.1.0-alpha.0.16",
    [switch]$NoAutoCollect,
    [switch]$NoLearning,
    [switch]$OnlineDoctor,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Success([string]$Message) {
    Write-Host "OK: $Message" -ForegroundColor Green
}

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable(
        "Path",
        "Machine"
    )
    $userPath = [Environment]::GetEnvironmentVariable(
        "Path",
        "User"
    )
    $env:Path = "$machinePath;$userPath"
}

function Require-Success(
    [string]$Operation,
    [int[]]$AllowedExitCodes = @(0)
) {
    if ($LASTEXITCODE -notin $AllowedExitCodes) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

function Ensure-UserPath([string]$Directory) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @(
        ($userPath -split ";" | Where-Object {
            -not [string]::IsNullOrWhiteSpace($_)
        })
    )
    $normalizedDirectory = $Directory.TrimEnd("\")
    $retained = @(
        $entries | Where-Object {
            $_.TrimEnd("\") -ine $normalizedDirectory
        }
    )
    $updated = @(
        $normalizedDirectory
        $retained
    ) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $updated, "User")
    $env:Path = "$normalizedDirectory;$env:Path"
}

function Resolve-ProvenLoopCommand([string]$InstallPrefix) {
    $candidate = Join-Path $InstallPrefix "provenloop.cmd"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return $candidate
    }
    throw "The provenloop command was not created by npm."
}

if ($env:OS -ne "Windows_NT") {
    throw "ProvenLoop 0.1 Alpha supports Windows only."
}
if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA is required to install ProvenLoop."
}
if (-not $env:TEMP) {
    throw "TEMP is required to install ProvenLoop."
}

$releaseRoot = (
    "https://github.com/cubika/ProvenLoop/releases/download/" +
    "v$Version"
)
$fileName = "provenloop-cli-$Version.tgz"
$packageUrl = "$releaseRoot/$fileName"
$checksumUrl = "$packageUrl.sha256"

if ($DryRun) {
    Write-Host "ProvenLoop installer dry run"
    Write-Host "Version: $Version"
    Write-Host "Package: $packageUrl"
    Write-Host "Checksum: $checksumUrl"
    Write-Host "Automatic collection: $(-not $NoAutoCollect)"
    Write-Host "Retrieval and correction learning: $(-not $NoLearning)"
    Write-Host "Online Doctor: $OnlineDoctor"
    return
}

Write-Step "Checking Node.js"
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($null -eq $winget) {
        throw (
            "Node.js >=22.16.0 is required. Install a compatible Node.js runtime, " +
            "then run this installer again."
        )
    }
    $choice = Read-Host (
        "Node.js is missing. Install Node.js 22 with winget? [Y/n]"
    )
    if (
        -not [string]::IsNullOrWhiteSpace($choice) -and
        $choice -notmatch "^[Yy]"
    ) {
        throw "Node.js installation was declined."
    }
    & $winget.Source install `
        --id OpenJS.NodeJS.22 `
        --exact `
        --source winget `
        --accept-source-agreements `
        --accept-package-agreements
    Require-Success "Node.js installation" @(0, -1978335189)
    Refresh-ProcessPath
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) {
        throw (
            "Node.js was installed but is not available in this shell. " +
            "Open a new terminal and run the installer again."
        )
    }
}

$nodeText = (& $nodeCommand.Source --version | Out-String).Trim()
Require-Success "Node.js version check"
$nodeVersion = [Version]($nodeText.TrimStart("v"))
if ($nodeVersion -lt [Version]"22.16.0") {
    throw (
        "ProvenLoop requires Node.js >=22.16.0. " +
        "Detected $nodeText. Upgrade Node.js and rerun the installer."
    )
}
& $nodeCommand.Source -e (
    "const { backup, DatabaseSync } = (() => {" +
    "const emitWarning = process.emitWarning;" +
    "process.emitWarning = (warning, ...args) => {" +
    "if (warning !== 'SQLite is an experimental feature and might change at any time' || " +
    "args[0] !== 'ExperimentalWarning') Reflect.apply(emitWarning, process, [warning, ...args]);" +
    "};" +
    "try { return require('node:sqlite'); } " +
    "finally { process.emitWarning = emitWarning; }" +
    "})();" +
    "const db = new DatabaseSync(':memory:', { timeout: 1 });" +
    "if (typeof backup !== 'function' || " +
    "db.prepare('PRAGMA busy_timeout').get().timeout !== 1) process.exit(1);" +
    "db.close();"
) 2>$null
if ($LASTEXITCODE -ne 0) {
    throw (
        "The installed Node.js runtime does not provide the required " +
        "node:sqlite DatabaseSync timeout and backup APIs."
    )
}
Write-Success "Node.js $nodeText"

Write-Step "Checking npm"
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) {
    throw "npm is required and was not found."
}
$npmText = (& $npmCommand.Source --version | Out-String).Trim()
Require-Success "npm version check"
$npmVersion = [Version]$npmText
if ($npmVersion.Major -lt 11) {
    throw (
        "ProvenLoop requires npm >=11. " +
        "Detected npm $npmText."
    )
}
Write-Success "npm $npmText"

Write-Step "Checking GitHub Copilot CLI"
$copilotCommand = Get-Command copilot.exe -ErrorAction SilentlyContinue
if ($null -eq $copilotCommand) {
    throw "GitHub Copilot CLI >=1.0.71 is required."
}
$copilotText = (& $copilotCommand.Source --version | Out-String).Trim()
Require-Success "Copilot CLI version check"
$copilotVersionMatch = [regex]::Match(
    $copilotText,
    "GitHub Copilot CLI\s+([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9]+))?(?:\.|\s|$)"
)
if (-not $copilotVersionMatch.Success) {
    throw (
        "Unable to parse the GitHub Copilot CLI version. " +
        "Detected: $copilotText"
    )
}
$copilotMajor = [int]$copilotVersionMatch.Groups[1].Value
$copilotMinor = [int]$copilotVersionMatch.Groups[2].Value
$copilotPatch = [int]$copilotVersionMatch.Groups[3].Value
if (
    $copilotMajor -lt 1 -or
    (
        $copilotMajor -eq 1 -and
        (
            $copilotMinor -lt 0 -or
            (
                $copilotMinor -eq 0 -and
                $copilotPatch -lt 71
            )
        )
    )
) {
    throw (
        "ProvenLoop 0.1 Alpha requires GitHub Copilot CLI >=1.0.71. " +
        "Detected: $copilotText"
    )
}
$requiredCopilotCommands = @(
    @{
        Arguments = @("plugin", "marketplace", "list", "--help")
        Operation = "Copilot Plugin Marketplace"
    },
    @{
        Arguments = @("plugin", "install", "--help")
        Operation = "Copilot Plugin installation"
    },
    @{
        Arguments = @("plugins", "enable", "--help")
        Operation = "Copilot Plugin enablement"
    },
    @{
        Arguments = @("plugins", "disable", "--help")
        Operation = "Copilot Plugin disablement"
    }
)
foreach ($requiredCommand in $requiredCopilotCommands) {
    $copilotArguments = [string[]]$requiredCommand.Arguments
    & $copilotCommand.Source @copilotArguments *> $null
    if ($LASTEXITCODE -ne 0) {
        throw (
            "$($requiredCommand.Operation) is unavailable in $copilotText. " +
            "ProvenLoop requires Plugin Marketplace, install, enable, and disable commands."
        )
    }
}
Write-Success $copilotText

$temporaryRoot = Join-Path (
    $env:TEMP
) "provenloop-install-$([Guid]::NewGuid().ToString('N'))"
$runtimeRoot = Join-Path $env:LOCALAPPDATA "ProvenLoopRuntime"
$runtimeSlotsRoot = Join-Path $runtimeRoot "versions"
$installPrefix = Join-Path $runtimeSlotsRoot $Version
$packagePath = Join-Path $temporaryRoot $fileName
$checksumPath = "$packagePath.sha256"
$existingInstallation = $false
$runtimeLocatorPath = Join-Path (
    $env:LOCALAPPDATA
) "ProvenLoopIntegration\runtime.json"
if (Test-Path -LiteralPath $runtimeLocatorPath -PathType Leaf) {
    try {
        $runtimeLocator = Get-Content `
            -LiteralPath $runtimeLocatorPath `
            -Raw `
            -Encoding UTF8 |
            ConvertFrom-Json
        if (
            $runtimeLocator.product -eq "ProvenLoopRuntime" -and
            $runtimeLocator.schemaVersion -eq 1 -and
            -not [string]::IsNullOrWhiteSpace(
                [string]$runtimeLocator.nodeExecutable
            ) -and
            -not [string]::IsNullOrWhiteSpace(
                [string]$runtimeLocator.cliBinPath
            ) -and
            (Test-Path `
                -LiteralPath $runtimeLocator.nodeExecutable `
                -PathType Leaf) -and
            (Test-Path `
                -LiteralPath $runtimeLocator.cliBinPath `
                -PathType Leaf)
        ) {
            $existingStatus = (
                & $runtimeLocator.nodeExecutable `
                    $runtimeLocator.cliBinPath `
                    status 2>$null |
                    Out-String
            ) | ConvertFrom-Json
            if (
                $LASTEXITCODE -eq 0 -and
                $existingStatus.installed -eq $true
            ) {
                $existingInstallation = $true
            }
        }
    } catch {
        $existingInstallation = $false
    }
}

try {
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null

    Write-Step "Downloading ProvenLoop $Version"
    Invoke-WebRequest `
        -Uri $packageUrl `
        -OutFile $packagePath `
        -UseBasicParsing
    Invoke-WebRequest `
        -Uri $checksumUrl `
        -OutFile $checksumPath `
        -UseBasicParsing

    Write-Step "Verifying SHA-256"
    $expectedHash = (
        Get-Content -LiteralPath $checksumPath -Raw
    ).Trim().Split()[0].ToLowerInvariant()
    if ($expectedHash -notmatch "^[a-f0-9]{64}$") {
        throw "The published checksum file is invalid."
    }
    $actualHash = (
        Get-FileHash -LiteralPath $packagePath -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "ProvenLoop package checksum mismatch."
    }
    Write-Success "Package checksum verified"

    Write-Step "Installing the verified local tarball into its runtime slot"
    & $npmCommand.Source install `
        --global `
        --prefix $installPrefix `
        $packagePath `
        --ignore-scripts `
        --no-audit `
        --no-fund
    Require-Success "ProvenLoop package installation"

    $provenLoopCommand = Resolve-ProvenLoopCommand $installPrefix
    $metadata = (
        & $provenLoopCommand version |
            Out-String
    ) | ConvertFrom-Json
    Require-Success "ProvenLoop version check"
    if ($metadata.version -ne $Version) {
        throw (
            "Installed ProvenLoop version $($metadata.version) " +
            "does not match $Version."
        )
    }
    Write-Success "Installed ProvenLoop $Version"

    Write-Step "Checking the target runtime integration state"
    $targetStatus = (& $provenLoopCommand status | Out-String) | ConvertFrom-Json
    Require-Success "Target integration status"
    $existingInstallation = $existingInstallation -or ($targetStatus.installed -eq $true)
    if ($NoAutoCollect -and $existingInstallation) {
        Write-Step "Disabling automatic collection before integration changes"
        & $provenLoopCommand collection disable | Out-Null
        Require-Success "Collection disable before upgrade"
    }
    if ($NoLearning -and $existingInstallation) {
        Write-Step "Disabling learning before integration changes"
        & $provenLoopCommand disable correction_learning | Out-Null
        Require-Success "Correction learning disable before upgrade"
        & $provenLoopCommand disable retrieval | Out-Null
        Require-Success "Retrieval disable before upgrade"
        & $provenLoopCommand learning disable | Out-Null
        Require-Success "Automatic learning opt-out before upgrade"
    }
    if (-not $NoLearning) {
        Write-Host "The installed runtime reports automatic-learning eligibility with provenloop learning status."
        Write-Host "It sends bounded, redacted conversation and tool excerpts to GitHub Copilot using your existing sign-in and service quota."
        Write-Host "Idle learning also classifies saved lesson text and conditions through the same provider, with a separate review and shared daily budget."
        Write-Host "Copilot service usage and retention policies apply. Use -NoLearning or provenloop learning disable to opt out."
    }
    $alreadyCurrent = (
        $targetStatus.installed -eq $true -and
        $targetStatus.pluginInstalled -eq $true -and
        $targetStatus.pluginVersion -eq $Version -and
        $targetStatus.marketplaceSource -eq "cubika/ProvenLoop#v$Version"
    )
    if ($alreadyCurrent) {
        Write-Step "Verifying the existing version-matched integration"
        $verificationArguments = @("install")
        if ($NoAutoCollect) {
            $verificationArguments += "--no-auto-collect"
        }
        & $provenLoopCommand @verificationArguments
        Require-Success "ProvenLoop integration verification"
    } elseif ($existingInstallation) {
        Write-Step "Upgrading the Copilot integration"
        & $provenLoopCommand upgrade
        Require-Success "ProvenLoop integration upgrade"
    } else {
        Write-Step "Registering the Copilot integration"
        $installArguments = @("install")
        if ($NoAutoCollect) {
            $installArguments += "--no-auto-collect"
        }
        & $provenLoopCommand @installArguments
        Require-Success "ProvenLoop integration installation"
    }

    Ensure-UserPath $installPrefix
    $resolvedCommand = Get-Command provenloop.cmd -ErrorAction SilentlyContinue
    if (
        $null -eq $resolvedCommand -or
        [IO.Path]::GetFullPath($resolvedCommand.Source) -ine
            [IO.Path]::GetFullPath($provenLoopCommand)
    ) {
        throw (
            "PATH does not resolve to the newly installed ProvenLoop " +
            "command at $provenLoopCommand."
        )
    }

    if ($NoLearning) {
        Write-Step "Keeping retrieval and correction learning disabled"
        & $provenLoopCommand learning disable | Out-Null
        Require-Success "Automatic learning opt-out"
        & $provenLoopCommand disable retrieval | Out-Null
        Require-Success "Retrieval disable"
        & $provenLoopCommand disable correction_learning | Out-Null
        Require-Success "Correction learning disable"
    } elseif (-not $existingInstallation) {
        Write-Step "Enabling retrieval and correction learning"
        & $provenLoopCommand enable retrieval | Out-Null
        Require-Success "Retrieval enable"
        & $provenLoopCommand enable correction_learning | Out-Null
        Require-Success "Correction learning enable"
    } else {
        Write-Step "Preserving existing learning capability settings"
    }
    $automaticLearningStatus = (& $provenLoopCommand learning status | Out-String) | ConvertFrom-Json
    Require-Success "Automatic learning status"

    Write-Step "Running passive Doctor"
    & $provenLoopCommand doctor
    Require-Success "Passive Doctor" @(0, 1)

    if ($OnlineDoctor) {
        Write-Step "Running opt-in online Doctor"
        & $provenLoopCommand doctor --online
        Require-Success "Online Doctor" @(0, 1)
    }

    $finalStatus = (
        & $provenLoopCommand status |
            Out-String
    ) | ConvertFrom-Json
    Require-Success "ProvenLoop status check"
    $capabilities = @{}
    foreach ($capability in $finalStatus.capabilities.capabilities) {
        $capabilities[$capability.capability] = [bool]$capability.enabled
    }
    $collectionEnabled = (
        $capabilities.capture -and
        $capabilities.worker
    )
    $learningEnabled = (
        $capabilities.retrieval -and
        $capabilities.correction_learning
    )

    Write-Host ""
    Write-Success "ProvenLoop installation completed"
    Write-Host "Command: $provenLoopCommand"
    Write-Host "Runtime slot: $installPrefix"
    Write-Host "Data: $env:LOCALAPPDATA\ProvenLoop"
    Write-Host (
        "Automatic collection: " +
        $(if ($collectionEnabled) { "enabled" } else { "disabled" })
    )
    Write-Host (
        "Retrieval and correction learning: " +
        $(if ($learningEnabled) { "enabled" } else { "disabled" })
    )
    Write-Host (
        "Automatic learning: " +
        $(if ($automaticLearningStatus.automaticLearning.enabled) { "enabled" } else { "disabled" })
    )
    if (-not $automaticLearningStatus.automaticLearning.enabled -and
        $null -ne $automaticLearningStatus.automaticLearning.PSObject.Properties['blockedBy']) {
        Write-Host ("Learning blocked by: " + ($automaticLearningStatus.automaticLearning.blockedBy -join ", "))
    }
    Write-Host "These settings do not confirm that a Copilot session has loaded automatic reuse hooks."
    Write-Host ""
    Write-Host "Check readiness in the repository where you use Copilot:"
    Write-Host '  provenloop learning status --cwd "C:\path\to\repository"'
    Write-Host "Follow its next steps for any missing collection, extraction or repository hook setup."
    Write-Host "Restart Copilot in that repository after setup so it can load the hooks."
    Write-Host ""
    Write-Host "See your first learned rule used:"
    Write-Host "  1. Complete a real task in Copilot. Correct a mistake or work through a recovery."
    Write-Host "  2. Run provenloop ui from that repository. Review Knowledge and its source evidence."
    Write-Host "     If no rule appears, inspect Learning for pending work or a reason extraction stopped."
    Write-Host "  3. Try a related task. Check Usage for guidance provided and inspect the linked rule."
    Write-Host "Guidance provided and explicit adoption are recorded separately; compare the agent's behavior."
} finally {
    Remove-Item `
        -LiteralPath $temporaryRoot `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
}
