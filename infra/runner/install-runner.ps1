# Installs one of this PC's GitHub Actions runners for html-proof/pixmagic-projects: the steps in
# docs/aws-deployment.md ("When GitHub-hosted jobs can't start"), in one go.
#   (no switch)  bizinsights-pc, as ghrunner in C:\actions-runner: pull requests' CI jobs
#                (SELF_HOSTED_RUNNER), and main's while there is no runner for main.
#   -Main        bizinsights-pc-main, as ghmain in C:\actions-runner-main: CI for pushes to main and
#                Deploy to AWS (SELF_HOSTED_MAIN_RUNNER). Its job hook refuses every other job, so
#                nothing a pull request's code leaves behind reaches the job that holds the deploy
#                role. Its e2e browsers are its own too (C:\ms-playwright-main).
#
# Run it in an elevated Windows PowerShell (right-click Windows PowerShell > Run as administrator):
#   powershell -ExecutionPolicy Bypass -File <this file> [-Main]
#
# What it does, stopping at the first error:
#   1. The runner folder, owned by Administrators and changeable by them and SYSTEM only. A folder
#      of that name someone else made first is refused (runner-folders.ps1): it may hold a planted
#      config.cmd, which this script would run elevated.
#   2. Downloads the runner and checks its SHA-256 against the release's published hash.
#   3. Creates the runner's local account (asks you for its password; nothing else uses it).
#      The runner runs as that account, so your own aws login and Git credentials stay out of reach.
#   4. C:\node_modules locked (harden-runner.ps1 says why). -Main also: the job hook
#      (infra/runner/main-only-hook.js), the browsers folder and the runner's .env, all before step
#      5 starts the service, so the hook is on from the runner's first job.
#   5. Registers the runner with a one-hour token from the gh CLI (or one you paste from GitHub).
#      config.cmd asks for the runner group (press Enter) and the account's password again.
#   6. Leaves the service only the two privileges it needs, then restarts it.
#   7. harden-runner.ps1 for the account: a password required, no logon but as the service.
# It doesn't switch CI over: the repository variables SELF_HOSTED_RUNNER and
# SELF_HOSTED_MAIN_RUNNER do that.
#Requires -RunAsAdministrator
param(
  [switch]$Main
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # PowerShell 5.1 downloads very slowly with the progress bar
. (Join-Path $PSScriptRoot 'runner-folders.ps1')

$repo = 'html-proof/pixmagic-projects'
$version = '2.338.0'
$sha256 = 'F48E0750A21812BCA5F82DE5F7F5AEAE71ABEE647FAB5A582F1742D07EBA455F'
if ($Main) {
  $name = 'bizinsights-pc-main'; $dir = 'C:\actions-runner-main'; $account = 'ghmain'
} else {
  $name = 'bizinsights-pc'; $dir = 'C:\actions-runner'; $account = 'ghrunner'
}
$service = "actions.runner.$($repo -replace '/', '-').$name"
$harden = Join-Path $PSScriptRoot 'harden-runner.ps1'
$hookDir = 'C:\ProgramData\bizinsights-runner'
$hook = Join-Path $hookDir 'main-only-hook.js'
$browsers = 'C:\ms-playwright-main'

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

if (Get-Service $service -ErrorAction SilentlyContinue) {
  throw "The runner service $service is already installed. To start over, see 'Back to GitHub's runners' in docs/aws-deployment.md."
}

Step "1/7 Folder $dir (owned by Administrators; they and SYSTEM only)"
Set-LockedFolder -Path $dir
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
  $pw = Read-Host -AsSecureString "Choose a long password for $account (you'll type it once more in step 5)"
  New-LocalUser $account -Password $pw -PasswordNeverExpires -UserMayNotChangePassword -Description 'GitHub Actions runner' | Out-Null
  Write-Host "Created (a standard user, not an administrator)."
}
$sid = (Get-LocalUser $account).SID.Value

Step "4/7 Folders the jobs run code from"
Set-LockedFolder -Path 'C:\node_modules' -UsersRead
Write-Host "C:\node_modules: users may read it, no one but administrators may change it."
if ($Main) {
  # Outside the runner folder (which config.cmd lets the runner change): administrators only, the
  # runner reads it. Its own package.json, so Node doesn't look further up for one.
  Set-LockedFolder -Path $hookDir -ReadExecute $sid
  Copy-Item -Force (Join-Path $PSScriptRoot 'main-only-hook.js') $hook
  Set-Content -Encoding ASCII (Join-Path $hookDir 'package.json') '{ "type": "commonjs" }'
  Set-LockedFolder -Path $hookDir -ReadExecute $sid
  # main's e2e job must not start the browsers in C:\ms-playwright, which pull-request jobs can
  # change: its own folder, only this account may write it. The first e2e run on main downloads
  # them (ci.yml, "Browser for the tests").
  Set-LockedFolder -Path $browsers -Modify $sid -AllowedOwners $sid
  # The runner reads .env when its service starts (step 5) and passes it on to every job.
  $envFile = Join-Path $dir '.env'
  $lines = @(Get-Content $envFile -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch '^(ACTIONS_RUNNER_HOOK_JOB_STARTED|PW_BROWSERS)=' })
  $lines + "ACTIONS_RUNNER_HOOK_JOB_STARTED=$hook" + "PW_BROWSERS=$browsers" | Set-Content -Encoding ASCII $envFile
  Write-Host "Every job starts with $hook; it lets through only main's CI and Deploy to AWS from main."
  Write-Host "The e2e job's browsers: $browsers."
}

Step "5/7 Register with GitHub as $name"
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
# The runner for main carries its own label only: a job asking for any self-hosted runner never
# lands there (its hook would refuse it).
$labels = @('--labels', $name)
if ($Main) { $labels += '--no-default-labels' }
& (Join-Path $dir 'config.cmd') --url "https://github.com/$repo" --token $token --name $name @labels --work _work --runasservice --windowslogonaccount ".\$account"
if ($LASTEXITCODE -ne 0) { throw "config.cmd failed ($LASTEXITCODE)" }
if ($Main) {
  $envLines = @(Get-Content (Join-Path $dir '.env') -ErrorAction SilentlyContinue)
  if ($envLines -notcontains "ACTIONS_RUNNER_HOOK_JOB_STARTED=$hook") {
    Stop-Service $service
    throw "config.cmd rewrote $dir\.env without the job hook. The service is stopped: run this script's step 4 lines again, then Start-Service $service."
  }
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
if ($Main) {
  Write-Host 'Then the repository variable SELF_HOSTED_MAIN_RUNNER = ["bizinsights-pc-main"].' -ForegroundColor Green
}
