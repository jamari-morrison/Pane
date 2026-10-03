# SOBECK Run 8: the real-user repo flow (D0-D9) driven in the side-by-side test build like a user, with a video of
# the whole run and a screenshot per step (..\real-user.mjs, MODE=relay). The output is shown live: the run PAUSES
# twice for Red's device sign-ins and says exactly what to do and which flag file to create to continue:
#   <Root>\flags\gh-signed-in      after the GitHub device sign-in in the "<host> · Terminal" tab
#   <Root>\flags\codex-signed-in   after the Codex device sign-in in the same tab
# Uses 2 test-wallet starts (Add, then one Stop/Start). No Playwright trace is recorded.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\PaneCloudSandbox\kit\run-real-user.ps1" `
#     -DebUrl <cs-<sha8> .deb url> -DebSha256 <its sha256>
param(
  [Parameter(Mandatory = $true)][string]$DebUrl,
  [Parameter(Mandatory = $true)][string]$DebSha256,
  [string]$Root = (Join-Path $env:USERPROFILE 'PaneCloudSandbox'),
  [string]$PaneDir = (Join-Path $env:USERPROFILE '.pane_cloudsandbox'),
  [string]$OutDir = '',
  [string]$Steps = '',
  [switch]$CloseRunning
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
$PaneDir = [IO.Path]::GetFullPath($PaneDir)
foreach ($forbidden in '.pane', '.pane_cloudtest') {
  if ($PaneDir.TrimEnd('\').Equals([IO.Path]::GetFullPath((Join-Path $env:USERPROFILE $forbidden)), 'OrdinalIgnoreCase')) {
    throw "Refusing: -PaneDir is $forbidden (the installed Pane, or the Run 4 test build)"
  }
}
if (-not $OutDir) { $OutDir = Join-Path $Root ("evidence\run8-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$flags = Join-Path $Root 'flags'
$exe = Join-Path $Root 'app\Pane.exe'
$kit = Join-Path $Root 'kit'
foreach ($path in @($exe, (Join-Path $kit 'real-user.mjs'), (Join-Path $kit 'node_modules\playwright-core'))) {
  if (-not (Test-Path $path)) { throw "Missing $path; run sobeck-install.ps1 -Root $Root -PaneDir $PaneDir first" }
}
New-Item -ItemType Directory -Force -Path $OutDir, $flags | Out-Null

$running = @(Get-Process -Name Pane -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith("$Root\", 'OrdinalIgnoreCase') })
if ($running.Count -gt 0) {
  if (-not $CloseRunning) { throw "The test build is running ($($running.Count) processes from $Root\app). Close its window, or re-run with -CloseRunning." }
  $running | Stop-Process -Force
  Start-Sleep -Seconds 2
}

$names = @{ MODE = 'relay'; PANE_BIN = $exe; PANE_DATA_DIR = $PaneDir; WORK = $OutDir; OUT = $OutDir; FLAG_DIR = $flags; PANE_DEB_URL = $DebUrl; PANE_DEB_SHA256 = $DebSha256.ToLower(); STEPS = $Steps }
foreach ($name in $names.Keys) { if ($names[$name]) { Set-Item "Env:\$name" $names[$name] } }
$env:ELECTRON_RUN_AS_NODE = '1'
$console = Join-Path $OutDir 'proof.console.txt'
try {
  # Piped, so PowerShell waits for it and every line (the pause instructions above all) shows as it happens.
  & $exe (Join-Path $kit 'real-user.mjs') 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $console
  $code = $LASTEXITCODE
} finally {
  foreach ($name in @($names.Keys) + 'ELECTRON_RUN_AS_NODE') { Remove-Item "Env:\$name" -ErrorAction SilentlyContinue }
}
$zip = "$OutDir.zip"
Compress-Archive -Path "$OutDir\*" -DestinationPath $zip -Force
Write-Host "Evidence: $OutDir"
Write-Host "Zip (send this back): $zip"
exit $code
