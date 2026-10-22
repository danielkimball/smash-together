param(
  [ValidateSet('install','start','run','stop','restart','status','uninstall')]
  [string]$Command = 'status'
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LocalDir = Join-Path $ProjectRoot '.local'
$TaskName = "SmashPortalHost-$env:USERNAME"
$Runner = Join-Path $PSScriptRoot 'windows-service.ps1'
New-Item -ItemType Directory -Path $LocalDir -Force | Out-Null
Set-Location $ProjectRoot
$Config = Get-Content -LiteralPath (Join-Path $LocalDir 'config.json') -Raw | ConvertFrom-Json
$NodePath = $Config.nodePath
if (!$NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
$ToolDirs = @((Split-Path $NodePath))
foreach ($Tool in @($Config.gitPath, $Config.ghPath)) { if ($Tool) { $ToolDirs += Split-Path $Tool } }
$env:Path = ($ToolDirs -join ';') + ';' + $env:Path

function Get-HostProcess {
  $PidFile = Join-Path $LocalDir 'host.pid'
  if (!(Test-Path $PidFile)) { return $null }
  $HostProcessId = 0
  if (![int]::TryParse((Get-Content $PidFile -Raw).Trim(), [ref]$HostProcessId)) { return $null }
  $Process = Get-CimInstance Win32_Process -Filter "ProcessId = $HostProcessId" -ErrorAction SilentlyContinue
  # Never terminate an unrelated process if Windows has reused a stale PID.
  if ($Process -and $Process.CommandLine -and $Process.CommandLine.Contains((Join-Path $PSScriptRoot 'host.mjs'))) { return $Process }
  return $null
}
function Stop-Host {
  $HostProcess = Get-HostProcess
  if ($HostProcess) { & taskkill.exe /PID $HostProcess.ProcessId /T /F | Out-Null }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    for ($Wait = 0; $Wait -lt 20; $Wait++) {
      if ((Get-ScheduledTask -TaskName $TaskName).State -ne 'Running') { break }
      Start-Sleep -Milliseconds 500
    }
  }
  Remove-Item (Join-Path $LocalDir 'host.pid') -Force -ErrorAction SilentlyContinue
}
function Start-Host {
  if (Get-HostProcess) { Write-Output 'Smash Portal is already running.'; return }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Start-ScheduledTask -TaskName $TaskName
  } else {
    $Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`" run"
    Start-Process -FilePath 'powershell.exe' -ArgumentList $Arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden | Out-Null
  }
  Write-Output 'Starting Smash Portal. Check status and .local/host.log.'
}
switch ($Command) {
  'run' {
    if (Get-HostProcess) { exit 0 }
    # The task is tied to the signed-in user, so gh uses that user's own login.
    Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class SmashPortalPower {
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
}
"@
    try {
      # Keep the system awake, while allowing the screen to switch off.
      [void][SmashPortalPower]::SetThreadExecutionState([uint32]2147483649)
      $ErrorActionPreference = 'Continue'
      & $NodePath (Join-Path $PSScriptRoot 'host.mjs') *>> (Join-Path $LocalDir 'host.log')
      exit $LASTEXITCODE
    } finally {
      [void][SmashPortalPower]::SetThreadExecutionState([uint32]2147483648)
    }
  }
  'install' {
    $TaskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Runner`" run" -WorkingDirectory $ProjectRoot
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $TaskUser
    $Principal = New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Limited
    $Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description 'Smash Portal room host and free Cloudflare connection' -Force | Out-Null
    Start-Host
  }
  'start' { Start-Host }
  'stop' { Stop-Host; Write-Output 'Stopped Smash Portal.' }
  'restart' { Stop-Host; Start-Host }
  'uninstall' {
    Stop-Host
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output 'Login task removed; project and local data retained.'
  }
  'status' {
    try { Invoke-RestMethod 'http://127.0.0.1:8787/api/status' | ConvertTo-Json }
    catch { Write-Output 'Smash Portal is stopped or still starting.' }
  }
}
