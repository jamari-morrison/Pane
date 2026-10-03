# Starts the side-by-side test build for hands-on use (a "drop"), with the Pane .deb that new sandboxes install and
# that "Update Pane" moves a sandbox to: the drop's own build, so the host has the drop's daemon channels.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\PaneCloudSandbox\kit\start-pane.ps1" `
#     -DebUrl <cs-<sha8> .deb url> -DebSha256 <its sha256>
param(
  [Parameter(Mandatory = $true)][string]$DebUrl,
  [Parameter(Mandatory = $true)][string]$DebSha256,
  [string]$Root = (Join-Path $env:USERPROFILE 'PaneCloudSandbox')
)
$ErrorActionPreference = 'Stop'
$exe = Join-Path ([IO.Path]::GetFullPath($Root)) 'app\Pane.exe'
if (-not (Test-Path $exe)) { throw "Missing $exe; run sobeck-install.ps1 first" }
if ($DebSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw '-DebSha256 must be the 64-hex SHA-256 of the .deb' }
$running = @(Get-Process -Name Pane -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith("$Root\", 'OrdinalIgnoreCase') })
if ($running.Count -gt 0) { throw "The test build is already running from $Root\app; close its window first (its environment can't be changed while it runs)." }
$psi = New-Object System.Diagnostics.ProcessStartInfo $exe
$psi.UseShellExecute = $false
foreach ($name in @($psi.EnvironmentVariables.Keys)) {
  if ($name -match '^(PANE_|RUNPANE_|ELECTRON_RUN_AS_NODE$)') { $psi.EnvironmentVariables.Remove($name) }
}
$psi.EnvironmentVariables['RUNPANE_CLOUD_PANE_DEB_URL'] = $DebUrl
$psi.EnvironmentVariables['RUNPANE_CLOUD_PANE_DEB_SHA256'] = $DebSha256.ToLower()
[void][System.Diagnostics.Process]::Start($psi)
Write-Host "Started $exe; new sandboxes and Update Pane use $DebUrl"
