# Installs one of this PC's GitHub Actions runners for html-proof/pixmagic-projects: the steps in
# docs/aws-deployment.md ("When GitHub-hosted jobs can't start"), in one go.
#   (no switch)  bizinsights-pc, as ghrunner in C:\actions-runner: CI's jobs (SELF_HOSTED_RUNNER).
#   -Deploy      bizinsights-pc-deploy, as ghdeploy in C:\actions-runner-deploy: Deploy to AWS only
#                (SELF_HOSTED_DEPLOY_RUNNER). Its job hook refuses every other job, so nothing a
#                pull request's code leaves behind reaches the job that holds the deploy role.
#
# Run it in an elevated Windows PowerShell (right-click Windows PowerShell > Run as administrator):
#   powershell -ExecutionPolicy Bypass -File <this file> [-Deploy]
#
# What it does, stopping at the first error:
#   1. The runner folder, changeable by Administrators and SYSTEM only.
#   2. Downloads the runner and checks its SHA-256 against the release's published hash.
#   3. Creates the runner's local account (asks you for its password; nothing else uses it).
#      The runner runs as that account, so your own aws login and Git credentials stay out of reach.
#   4. Registers the runner with a one-hour token from the gh CLI (or one you paste from GitHub).
#      config.cmd asks for the runner group (press Enter) and the account's password again.
#   5. -Deploy only: the job hook (infra/runner/deploy-only-hook.js).
#   6. Leaves the service only the two privileges it needs, then restarts it.
#   7. harden-runner.ps1 for the account: a password required, no logon but as the service.
# It doesn't switch CI over: the repository variables SELF_HOSTED_RUNNER and
# SELF_HOSTED_DEPLOY_RUNNER do that.
#Requires -RunAsAdministrator
param(
  [switch]$Deploy
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # PowerShell 5.1 downloads very slowly with the progress bar

$repo = 'html-proof/pixmagic-projects'
$version = '2.338.0'
$sha256 = 'F48E0750A21812BCA5F82DE5F7F5AEAE71ABEE647FAB5A582F1742D07EBA455F'
if ($Deploy) {
  $name = 'bizinsights-pc-deploy'; $dir = 'C:\actions-runner-deploy'; $account = 'ghdeploy'
} else {
  $name = 'bizinsights-pc'; $dir = 'C:\actions-runner'; $account = 'ghrunner'
}
$service = "actions.runner.$($repo -replace '/', '-').$name"
$harden = Join-Path $PSScriptRoot 'harden-runner.ps1'

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

if (Get-Service $service -ErrorAction SilentlyContinue) {
  throw "The runner service $service is already installed. To start over, see 'Back to GitHub's runners' in docs/aws-deployment.md."
}

Step "1/7 Folder $dir (Administrators and SYSTEM only)"
New-Item -ItemType Directory -Force $dir | Out-Null
icacls $dir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed ($LASTEXITCODE)" }
Set-Location $dir

Step "2/7 Runner v$version"
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

Step "3/7 Local account $account"
if (Get-LocalUser $account -ErrorAction SilentlyContinue) {
  Write-Host "Already exists."
  # A runner registered before may have left it hardened: config.cmd checks the password with a
  # network logon.
  & $harden -Account $account -Release
} else {
  $pw = Read-Host -AsSecureString "Choose a long password for $account (you'll type it once more in step 4)"
  New-LocalUser $account -Password $pw -PasswordNeverExpires -UserMayNotChangePassword -Description 'GitHub Actions runner' | Out-Null
  Write-Host "Created (a standard user, not an administrator)."
}

Step "4/7 Register with GitHub as $name"
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
# The deploy runner carries its own label only: a job asking for any self-hosted runner never
# lands there (its hook would refuse it).
$labels = @('--labels', $name)
if ($Deploy) { $labels += '--no-default-labels' }
& (Join-Path $dir 'config.cmd') --url "https://github.com/$repo" --token $token --name $name @labels --work _work --runasservice --windowslogonaccount ".\$account"
if ($LASTEXITCODE -ne 0) { throw "config.cmd failed ($LASTEXITCODE)" }

Step "5/7 Job hook"
if ($Deploy) {
  # Outside the runner folder (which config.cmd lets the runner change): administrators only, the
  # runner reads it. The runner reads .env when its service starts (step 6).
  $hookDir = 'C:\ProgramData\bizinsights-runner'
  $sid = (Get-LocalUser $account).SID.Value
  New-Item -ItemType Directory -Force $hookDir | Out-Null
  icacls $hookDir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "*$($sid):(OI)(CI)RX" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls $hookDir failed ($LASTEXITCODE)" }
  $hook = Join-Path $hookDir 'deploy-only-hook.js'
  Copy-Item -Force (Join-Path $PSScriptRoot 'deploy-only-hook.js') $hook
  $envFile = Join-Path $dir '.env'
  $lines = @(Get-Content $envFile -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch '^ACTIONS_RUNNER_HOOK_JOB_STARTED=' })
  $lines + "ACTIONS_RUNNER_HOOK_JOB_STARTED=$hook" | Set-Content -Encoding ASCII $envFile
  Write-Host "Every job starts with $hook; it lets through only Deploy to AWS from main."
} else {
  Write-Host "None (CI's runner)."
}

Step "6/7 Service privileges"
# A service may impersonate other users by default, which local exploits turn into SYSTEM.
sc.exe privs $service SeChangeNotifyPrivilege/SeIncreaseWorkingSetPrivilege | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc.exe privs failed ($LASTEXITCODE)" }
Restart-Service $service
Get-Service $service | Format-Table Name, Status, StartType -AutoSize

Step "7/7 Account ${account}: a password required, no logon but as the service"
& $harden -Account $account

Write-Host "`nDone. GitHub > Settings > Actions > Runners should show $name as Idle." -ForegroundColor Green
if ($Deploy) {
  Write-Host 'Then the repository variable SELF_HOSTED_DEPLOY_RUNNER = ["bizinsights-pc-deploy"].' -ForegroundColor Green
}
