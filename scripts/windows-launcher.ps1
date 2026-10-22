function Get-SmashBackgroundLauncher {
  $Source = Join-Path $PSScriptRoot 'windows-runner.cs'
  $LocalDir = Join-Path (Split-Path -Parent $PSScriptRoot) '.local'
  New-Item -ItemType Directory -Path $LocalDir -Force | Out-Null
  # Versioned paths allow a running task to retain its executable during upgrades.
  $Hash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
  $Launcher = Join-Path $LocalDir "windows-runner-$Hash.exe"
  if (!(Test-Path -LiteralPath $Launcher)) {
    Add-Type -Path $Source -OutputAssembly $Launcher -OutputType WindowsApplication
  }
  return $Launcher
}

function Update-SmashHostingShortcuts {
  $Launcher = Get-SmashBackgroundLauncher
  $Folder = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Smash Portal'
  if (!(Test-Path -LiteralPath $Folder)) { return }
  $Shell = New-Object -ComObject WScript.Shell
  foreach ($Command in @('Start','Stop','Restart')) {
    $Path = Join-Path $Folder "$Command Hosting.lnk"
    if (!(Test-Path -LiteralPath $Path)) { continue }
    $Link = $Shell.CreateShortcut($Path)
    $Link.TargetPath = $Launcher
    $Link.Arguments = 'host ' + $Command.ToLowerInvariant()
    $Link.WorkingDirectory = Split-Path -Parent $PSScriptRoot
    $Link.WindowStyle = 1
    $Link.Save()
  }
}
