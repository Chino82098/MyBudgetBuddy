# Creates "Budget Buddy" shortcuts on the Desktop and in the Start Menu.
# The shortcut opens the Electron window directly, so no terminal appears.
$ErrorActionPreference = 'Stop'
$appDir   = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
$icon     = Join-Path $appDir 'assets\icon.ico'

if (-not (Test-Path $electron)) { throw "Electron not found at $electron. Run 'npm install' first." }

$ws = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    $lnk = $ws.CreateShortcut((Join-Path $dir 'Budget Buddy.lnk'))
    $lnk.TargetPath       = $electron
    $lnk.Arguments        = '"' + $appDir + '"'
    $lnk.WorkingDirectory = $appDir
    $lnk.IconLocation     = "$icon,0"
    $lnk.Description      = 'Budget Buddy'
    $lnk.Save()
    Write-Host "Created $(Join-Path $dir 'Budget Buddy.lnk')"
}
