# Creates (or updates) the "BAPTOU Admin" shortcuts on the Desktop and in the Start menu.
# They open the admin app with its own icon. Run again after moving the repository:
#   npm run shortcuts   (in the admin folder)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$electron = Join-Path $here "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electron)) { throw "Electron is missing. Run: npm install (in $here)" }
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))) {
  $link = $shell.CreateShortcut((Join-Path $folder "BAPTOU Admin.lnk"))
  $link.TargetPath = $electron
  $link.Arguments = '"' + $here + '"'
  $link.WorkingDirectory = $here
  $link.IconLocation = (Join-Path $here "baptou.ico") + ",0"
  $link.Description = "BAPTOU Admin: subscribers, website visits, gifts and allowances"
  $link.Save()
  Write-Output ("Shortcut: " + $link.FullName)
}
