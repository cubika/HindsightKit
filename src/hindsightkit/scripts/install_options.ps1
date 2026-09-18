function Resolve-InstallMode([System.Collections.IDictionary]$Options) {
    if ($Options['Server'] -or $Options['ClientOnly']) { return 'client-only' }
    if ($Options['ServerOnly']) { return 'server-only' }
    if ($Options.ContainsKey('ClientOnly')) { return 'full' }
    # The release bootstrap resolves defaults before selecting an archive.
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

function Assert-InstallOptions([System.Collections.IDictionary]$Options, [string]$Mode) {
    if ($Mode -eq 'client-only') {
        if ($Options['ServerOnly']) { throw 'ServerOnly and client-only options cannot be combined.' }
        if ($Options['Model'] -or $Options['ModelDir'] -or $Options['Port'] -or $Options['ReasoningEffort']) {
            throw 'Model and port options belong on the server.'
        }
        if ($Options['ApiKeyEnv'] -and -not $Options['Server']) {
            throw '-ApiKeyEnv requires -Server during client-only installation.'
        }
    }
    if ($Options['ReasoningEffort'] -and $Options['ReasoningEffort'] -notin @('low', 'medium', 'high', 'xhigh', 'max')) {
        throw 'Unknown reasoning effort.'
    }
    $port = $Options['Port']
    # The dashboard and connector service also need valid derived ports.
    if ($port -and ($port -lt 1024 -or $port -gt 55534)) {
        throw 'Choose an API port between 1024 and 55534, or 0 for the default.'
    }
    $server = $Options['Server']
    if ($server) {
        $parsed = [uri]$server
        if ($parsed.Scheme -notin @('http', 'https') -or -not $parsed.Host -or $parsed.UserInfo -or
            $parsed.Query -or $parsed.Fragment -or $parsed.AbsolutePath -ne '/' -or $server -match '\s') {
            throw 'Use an HTTP(S) server address without credentials, path, query, or fragment.'
        }
    }
}
