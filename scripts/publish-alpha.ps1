param(
    [Parameter(Mandatory)]
    [string]$Version,
    [switch]$SkipNpmPublish
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$expectedTag = "v$Version"
$packageVersion = node -p "require('./package.json').version"
if ($LASTEXITCODE -ne 0 -or $packageVersion -ne $Version) {
    throw "Package version does not match $Version."
}
$branch = git branch --show-current
if ($LASTEXITCODE -ne 0 -or $branch -ne "master") {
    throw "Alpha releases must be published from master."
}
if (git status --porcelain) {
    throw "The Git worktree must be clean before publishing."
}
$head = git rev-parse HEAD
if ($LASTEXITCODE -ne 0) {
    throw "Unable to resolve the release commit."
}
$localTag = git tag --list $expectedTag
if ($localTag) {
    $localCommit = git rev-parse "$expectedTag^{}"
    if ($LASTEXITCODE -ne 0 -or $localCommit -ne $head) {
        throw "Existing local release tag does not resolve to HEAD."
    }
}
$remoteTag = git ls-remote `
    --tags `
    origin `
    "refs/tags/$expectedTag" `
    "refs/tags/$expectedTag^{}"
if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect the remote release tag."
}
if ($remoteTag) {
    $remoteCommit = (
        @($remoteTag) |
            Select-Object -Last 1
    ).Split("`t")[0]
    if ($remoteCommit -ne $head) {
        throw "Existing remote release tag does not resolve to HEAD."
    }
}

npm.cmd run package:verify
if ($LASTEXITCODE -ne 0) {
    throw "Packed artifact verification failed."
}
if (git status --porcelain) {
    throw "Package verification changed tracked release files."
}

$artifactRoot = Join-Path (
    ".provenloop"
) "publish-$Version-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $artifactRoot | Out-Null
$packed = npm.cmd pack `
    --workspace @provenloop/cli `
    --json `
    --pack-destination $artifactRoot |
    ConvertFrom-Json
if ($LASTEXITCODE -ne 0) {
    throw "Unable to create the release tarball."
}
$tarball = Join-Path $artifactRoot $packed.filename
$expectedIntegrity = [string]$packed.integrity

if (-not $remoteTag) {
    if (-not $localTag) {
        git tag -a $expectedTag -m "ProvenLoop $Version"
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to create the release tag."
        }
    }
    git push origin $expectedTag
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to push the release tag."
    }
}

if (-not $SkipNpmPublish) {
    function Get-PublishedIntegrity {
        $value = npm.cmd view "@provenloop/cli@$Version" dist.integrity `
            --json `
            --registry=https://registry.npmjs.org 2> $null
        if ($LASTEXITCODE -ne 0) {
            return $null
        }
        $value | ConvertFrom-Json
    }

    $publishedIntegrity = Get-PublishedIntegrity
    if ($null -eq $publishedIntegrity) {
        npm.cmd publish `
            $tarball `
            --access public `
            --tag alpha `
            --registry=https://registry.npmjs.org
        if ($LASTEXITCODE -ne 0) {
            throw "npm publication failed."
        }
        for ($attempt = 0; $attempt -lt 10; $attempt += 1) {
            Start-Sleep -Seconds 3
            $publishedIntegrity = Get-PublishedIntegrity
            if ($null -ne $publishedIntegrity) {
                break
            }
        }
    }
    if ($publishedIntegrity -ne $expectedIntegrity) {
        throw "Published npm artifact does not match the verified tarball."
    }
}

Remove-Item -LiteralPath $artifactRoot -Recurse -Force
if ($SkipNpmPublish) {
    Write-Output "Published Git tag $expectedTag; npm publication skipped."
} else {
    Write-Output "Published @provenloop/cli@$Version and $expectedTag."
}
