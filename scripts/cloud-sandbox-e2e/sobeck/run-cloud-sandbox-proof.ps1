# SOBECK Run 5: "Add cloud sandbox" from the Remotes settings of the side-by-side test build, driven like a
# user by ..\e2e.mjs (MODE=relay): Add cloud sandbox -> listed and connected -> a Claude panel answers in a
# new Pane -> Stop -> Start (same tailnet name, Pane back, the conversation resumes) -> Remove -> the hosts
# saved before (Scratch) unchanged, no saved token in the evidence.
#
# Needs: install.ps1 run with -Root/-PaneDir of this build, and the credentials entered once in the app
# (Settings -> Connections -> Cloud sandboxes, boat wallet "test"). The proof reads no credential and records
# no Playwright trace; screenshots are of the app window only. Uses 2 boat starts (create, Start).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\PaneCloudSandbox\kit\run-cloud-sandbox-proof.ps1" `
#     -DebUrl <cs-<sha8> .deb url> -DebSha256 <its sha256>
param(
  [Parameter(Mandatory = $true)][string]$DebUrl,
  [Parameter(Mandatory = $true)][string]$DebSha256,
  [string]$Root = (Join-Path $env:USERPROFILE 'PaneCloudSandbox'),
  [string]$PaneDir = (Join-Path $env:USERPROFILE '.pane_cloudsandbox'),
  [string]$OutDir = '',
  [string]$Phases = '',
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
if (-not $OutDir) { $OutDir = Join-Path $Root ("evidence\run5-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$exe = Join-Path $Root 'app\Pane.exe'
$kit = Join-Path $Root 'kit'
foreach ($path in @($exe, (Join-Path $kit 'e2e.mjs'), (Join-Path $kit 'node_modules\playwright-core'))) {
  if (-not (Test-Path $path)) { throw "Missing $path; run install.ps1 -Root $Root -PaneDir $PaneDir first" }
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$running = @(Get-Process -Name Pane -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith("$Root\", 'OrdinalIgnoreCase') })
if ($running.Count -gt 0) {
  if (-not $CloseRunning) { throw "The test build is running ($($running.Count) processes from $Root\app). Close its window, or re-run with -CloseRunning to close it." }
  Write-Host "Closing the running test build ($($running.Count) processes)"
  $running | Stop-Process -Force
  Start-Sleep -Seconds 2
}

$names = @{ MODE = 'relay'; PANE_BIN = $exe; PANE_DATA_DIR = $PaneDir; WORK = $OutDir; OUT = $OutDir; PANE_DEB_URL = $DebUrl; PANE_DEB_SHA256 = $DebSha256; PHASES = $Phases }
foreach ($name in $names.Keys) { if ($names[$name]) { Set-Item "Env:\$name" $names[$name] } }
$env:ELECTRON_RUN_AS_NODE = '1'
$stdout = Join-Path $OutDir 'proof.out.txt'
$stderr = Join-Path $OutDir 'proof.err.txt'
try {
  $process = Start-Process -FilePath $exe -ArgumentList "`"$(Join-Path $kit 'e2e.mjs')`"" -WorkingDirectory $kit -Wait -NoNewWindow -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
} finally {
  foreach ($name in @($names.Keys) + 'ELECTRON_RUN_AS_NODE') { Remove-Item "Env:\$name" -ErrorAction SilentlyContinue }
}
Get-Content $stdout, $stderr -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
$zip = "$OutDir.zip"
Compress-Archive -Path "$OutDir\*" -DestinationPath $zip -Force
Write-Host "Evidence: $OutDir"
Write-Host "Zip: $zip"
exit $process.ExitCode
