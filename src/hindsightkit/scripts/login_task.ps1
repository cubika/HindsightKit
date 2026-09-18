param(
    [Parameter(Mandatory=$true)][ValidateSet('install', 'remove', 'status')][string]$Action,
    [Parameter(Mandatory=$true)][string]$Root,
    [switch]$Enable
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
    $Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant()))).Replace('-', '').Substring(0, 16) }
    finally { $hash.Dispose() }
    $name = 'HindsightKit-Login-' + $sid + '-' + $digest
    $owner = 'HindsightKit login startup v1: ' + $Root
    $script = Join-Path $Root 'bin/login-startup.ps1'
    $shell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"'
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $folder = $scheduler.GetFolder('\')
    $task = $null
    try { $task = $folder.GetTask($name) }
    catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
    if ($task) {
        $definition = $task.Definition
        # Task Scheduler can return the account name even when registered by SID.
        $principal = $definition.Principal.UserId
        if ($principal -notmatch '^S-1-') {
            $principal = (New-Object Security.Principal.NTAccount($principal)).Translate([Security.Principal.SecurityIdentifier]).Value
        }
        if ($definition.RegistrationInfo.Source -cne $owner -or
            $principal -ne $sid -or $definition.Principal.LogonType -ne 3 -or
            $definition.Principal.RunLevel -ne 0 -or $definition.Actions.Count -ne 1 -or
            $definition.Actions.Item(1).Path -ne $shell -or
            $definition.Actions.Item(1).Arguments -cne $arguments -or
            $definition.Actions.Item(1).WorkingDirectory -ne $Root) {
            throw "Scheduled task $name is not owned by this installation; it was preserved."
        }
    }
    if ($Action -eq 'remove' -and $task) {
        $folder.DeleteTask($name, 0)
        $task = $null
    } elseif ($Action -eq 'install') {
        if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw 'Login startup script is missing.' }
        $definition = $scheduler.NewTask(0)
        $definition.RegistrationInfo.Source = $owner
        $definition.RegistrationInfo.Description = 'Resume HindsightKit 30 seconds after this user signs in to Windows.'
        $definition.Principal.UserId = $sid
        $definition.Principal.LogonType = 3 # Interactive token; no password stored.
        $definition.Principal.RunLevel = 0 # Current user, without elevation.
        $trigger = $definition.Triggers.Create(9) # Logon
        $trigger.UserId = $sid
        $trigger.Delay = 'PT30S'
        $exec = $definition.Actions.Create(0)
        $exec.Path = $shell
        $exec.Arguments = $arguments
        $exec.WorkingDirectory = $Root
        $definition.Settings.Enabled = $Enable -or -not $task -or $task.Enabled
        $definition.Settings.StartWhenAvailable = $true
        $definition.Settings.DisallowStartIfOnBatteries = $false
        $definition.Settings.StopIfGoingOnBatteries = $false
        $definition.Settings.MultipleInstances = 2 # Ignore a duplicate invocation.
        # Services can outlive the launcher; never terminate them at a task time limit.
        $definition.Settings.ExecutionTimeLimit = 'PT0S'
        $definition.Settings.RestartInterval = 'PT1M'
        $definition.Settings.RestartCount = 3
        $flags = if ($task) { 4 } else { 2 } # Update an owned task, otherwise create only.
        $task = $folder.RegisterTaskDefinition($name, $definition, $flags, $sid, $null, 3, $null)
    }
    @{ exists=[bool]$task; enabled=[bool]($task -and $task.Enabled); name=$name;
       lastResult=$(if ($task) { $task.LastTaskResult } else { $null }) } | ConvertTo-Json -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
