# Puts the user's own cloud sandbox startup script back after a Run 8 that could not (results.json:
# "startupScriptRestored": false). The kit saved it beside the live file as startup.sh.e2e-original-<sha256[:12]>.
# This only writes the FILE on this computer (nothing is pushed to any sandbox); the desktop reads that file fresh on
# every sandbox Create/Start. It never prints the script: only lengths and hashes. Close the test build first.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\PaneCloudSandbox\kit\restore-startup-script.ps1"
param(
  [string]$Root = (Join-Path $env:USERPROFILE 'PaneCloudSandbox'),
  [string]$PaneDir = (Join-Path $env:USERPROFILE '.pane_cloudsandbox')
)
$ErrorActionPreference = 'Stop'
$running = @(Get-Process -Name Pane -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith("$Root\", 'OrdinalIgnoreCase') })
if ($running.Count -gt 0) { throw "Close the test build first (it is running from $Root\app); a Save from its editor would undo this." }
$dir = Join-Path $PaneDir 'cloud-sandboxes'
$file = Join-Path $dir 'startup.sh'
$copies = @(Get-ChildItem -Path $dir -Filter 'startup.sh.e2e-original-*' -ErrorAction SilentlyContinue)
if ($copies.Count -eq 0) { Write-Host 'No saved copy: the run restored the startup script itself (or never changed it). Nothing to do.'; exit 0 }
if ($copies.Count -gt 1) { throw "More than one saved copy in $dir; keep the newest and remove the others by hand." }
$copy = $copies[0]
$want = $copy.Name.Substring('startup.sh.e2e-original-'.Length).ToLower()
$have = (Get-FileHash -Algorithm SHA256 $copy.FullName).Hash.ToLower()
if (-not $have.StartsWith($want)) { throw "The saved copy does not match its sha256 ($want): not restoring." }
$temporary = "$file.e2e-restore.tmp"
Copy-Item -LiteralPath $copy.FullName -Destination $temporary -Force
Move-Item -LiteralPath $temporary -Destination $file -Force
$after = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
if ($after -ne $have) { throw "The restored file's sha256 differs ($($after.Substring(0,12)) vs $($have.Substring(0,12)))." }
Remove-Item -LiteralPath $copy.FullName -Force
Write-Host "startupScriptRestored: true (sha256 $($after.Substring(0,12)), length $((Get-Item $file).Length)); the saved copy was removed."
