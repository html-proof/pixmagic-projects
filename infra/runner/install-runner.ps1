# Installs this PC's GitHub Actions runner "bizinsights-pc" for html-proof/pixmagic-projects: the
# steps in docs/aws-deployment.md ("When GitHub-hosted jobs can't start"), in one go.
#
# Run it in an elevated Windows PowerShell (right-click Windows PowerShell > Run as administrator):
#   powershell -ExecutionPolicy Bypass -File <this file>
#
# What it does, stopping at the first error:
#   1. C:\actions-runner, changeable by Administrators and SYSTEM only.
#   2. Downloads the runner and checks its SHA-256 against the release's published hash.
#   3. Creates the local account "ghrunner" (asks you for its password; nothing else uses it).
#      The runner runs as that account, so your own aws login and Git credentials stay out of reach.
#   4. Registers the runner with a one-hour token from the gh CLI (or one you paste from GitHub).
#      config.cmd asks for the runner group (press Enter) and the ghrunner password again.
#   5. Leaves the service only the two privileges it needs, then restarts it.
# It doesn't switch CI over: the repository variable SELF_HOSTED_RUNNER does that.
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # PowerShell 5.1 downloads very slowly with the progress bar

$repo = 'html-proof/pixmagic-projects'
$version = '2.338.0'
$sha256 = 'F48E0750A21812BCA5F82DE5F7F5AEAE71ABEE647FAB5A582F1742D07EBA455F'
$dir = 'C:\actions-runner'
$account = 'ghrunner'

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

if (Get-Service 'actions.runner.*' -ErrorAction SilentlyContinue) {
  throw "A runner service is already installed (Get-Service 'actions.runner.*'). To start over, see 'Back to GitHub's runners' in docs/aws-deployment.md."
}

Step "1/5 Folder $dir (Administrators and SYSTEM only)"
New-Item -ItemType Directory -Force $dir | Out-Null
icacls $dir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed ($LASTEXITCODE)" }
Set-Location $dir

Step "2/5 Runner v$version"
if (-not (Test-Path (Join-Path $dir 'config.cmd'))) {
  $zip = Join-Path $dir 'actions-runner.zip'
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/actions/runner/releases/download/v$version/actions-runner-win-x64-$version.zip" -OutFile $zip
  $hash = (Get-FileHash $zip -Algorithm SHA256).Hash
  if ($hash -ne $sha256) { Remove-Item $zip; throw "Checksum mismatch: got $hash, expected $sha256. Nothing was installed." }
  Expand-Archive $zip -DestinationPath $dir
  Remove-Item $zip
  Write-Host "Downloaded, checksum OK."
} else {
  Write-Host "Already there."
}

Step "3/5 Local account $account"
if (Get-LocalUser $account -ErrorAction SilentlyContinue) {
  Write-Host "Already exists."
} else {
  $pw = Read-Host -AsSecureString "Choose a long password for $account (you'll type it once more in step 4)"
  New-LocalUser $account -Password $pw -PasswordNeverExpires -UserMayNotChangePassword -Description 'GitHub Actions runner' | Out-Null
  Write-Host "Created (a standard user, not an administrator)."
}

Step "4/5 Register with GitHub as bizinsights-pc"
$token = $null
if (Get-Command gh -ErrorAction SilentlyContinue) {
  # Windows PowerShell turns a native command's stderr into errors, which 'Stop' would throw.
  $ErrorActionPreference = 'Continue'
  $token = gh api -X POST "repos/$repo/actions/runners/registration-token" --jq .token 2>$null
  if ($LASTEXITCODE -ne 0) { $token = $null }
  $ErrorActionPreference = 'Stop'
}
if (-not $token) {
  Write-Host "The gh CLI couldn't make a token here. On GitHub: the repository > Settings > Actions > Runners >"
  Write-Host "New self-hosted runner > Windows, and copy the value after --token in the config.cmd line."
  $token = Read-Host "Paste that token"
}
Write-Host "Press Enter for the runner group, then type the $account password."
& (Join-Path $dir 'config.cmd') --url "https://github.com/$repo" --token $token --name bizinsights-pc --labels bizinsights-pc --work _work --runasservice --windowslogonaccount ".\$account"
if ($LASTEXITCODE -ne 0) { throw "config.cmd failed ($LASTEXITCODE)" }

Step "5/5 Service privileges"
# A service may impersonate other users by default, which local exploits turn into SYSTEM.
$svc = (Get-Service 'actions.runner.*').Name
sc.exe privs $svc SeChangeNotifyPrivilege/SeIncreaseWorkingSetPrivilege | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc.exe privs failed ($LASTEXITCODE)" }
Restart-Service $svc
Get-Service $svc | Format-Table Name, Status, StartType -AutoSize

Write-Host "`nDone. GitHub > Settings > Actions > Runners should show bizinsights-pc as Idle." -ForegroundColor Green
