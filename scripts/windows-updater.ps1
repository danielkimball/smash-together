param(
  [ValidateSet('install','run','status','uninstall')]
  [string]$Command = 'status'
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LocalDir = Join-Path $ProjectRoot '.local'
$TaskName = "SmashPortalUpdates-$env:USERNAME"
$Runner = Join-Path $PSScriptRoot 'windows-updater.ps1'
$Config = Get-Content -LiteralPath (Join-Path $LocalDir 'config.json') -Raw | ConvertFrom-Json
$NodePath = $Config.nodePath
if (!$NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
Set-Location $ProjectRoot
switch ($Command) {
  'run' {
    # Native stderr contains normal git progress; preserve it in the private log.
    $ErrorActionPreference = 'Continue'
    & $NodePath (Join-Path $PSScriptRoot 'auto-update.mjs') *>> (Join-Path $LocalDir 'updates.log')
    exit $LASTEXITCODE
  }
  'install' {
    $TaskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Runner`" run" -WorkingDirectory $ProjectRoot
    $Login = New-ScheduledTaskTrigger -AtLogOn -User $TaskUser
    $Repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $Principal = New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Limited
    $Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger @($Login,$Repeat) -Principal $Principal -Settings $Settings -Description 'Test and deploy main updates when Smash Portal has no rooms' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Output 'Automatic main updates enabled; checks run every minute while signed in.'
  }
  'status' {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Select-Object TaskName,State
    Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue | Select-Object LastRunTime,LastTaskResult,NextRunTime
    Get-Content -LiteralPath (Join-Path $LocalDir 'updates.log') -Tail 12 -ErrorAction SilentlyContinue
  }
  'uninstall' {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output 'Automatic update task removed.'
  }
}
