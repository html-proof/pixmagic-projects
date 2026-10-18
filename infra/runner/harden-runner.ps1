# Locks down the PC's GitHub Actions runner accounts and the browsers the e2e job runs: the
# owner-run half of "Hardening the runner" in docs/aws-deployment.md. install-runner.ps1 runs it for
# the account it creates; run it by hand once for a runner installed before it existed. Safe to run
# again.
#
# Run it in an elevated Windows PowerShell (right-click Windows PowerShell > Run as administrator):
#   powershell -ExecutionPolicy Bypass -File <this file>
#
# For each runner account (ghrunner and ghmain, those that exist; or the ones -Account names):
#   1. A password is required: New-LocalUser leaves "password not required" (PASSWD_NOTREQD) set.
#   2. No logon but as its service: local, Remote Desktop and network logon denied.
# Then the e2e job's browsers (PLAYWRIGHT_BROWSERS_PATH in ci.yml): C:\ms-playwright changeable by
# administrators, SYSTEM and ghrunner only (it downloads new browser builds), readable by users;
# C:\ms-playwright-main (the runner for main's) the same with ghmain, and not readable by others.
# C:\ inherits "Authenticated Users: Modify" to new folders, so any account on the PC could swap
# the chrome.exe a runner starts.
#
# -Release allows the -Account accounts network logon again: config.cmd checks the password with
# one, so install-runner.ps1 lifts that denial while it registers a runner, then puts it back.
#Requires -RunAsAdministrator
param(
  [string[]]$Account,
  [switch]$Release
)
$ErrorActionPreference = 'Stop'

$rights = 'SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight', 'SeDenyNetworkLogonRight'
# Each runner downloads new browser builds into its own folder (PW_BROWSERS; ci.yml).
$browsers = @(
  @{ Path = 'C:\ms-playwright'; Writer = 'ghrunner'; UsersRead = $true },
  @{ Path = 'C:\ms-playwright-main'; Writer = 'ghmain'; UsersRead = $false }
)

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

# The three rights as secedit exports them: right name -> its members (*SID, or a name).
function Get-DenyRights($work) {
  $inf = Join-Path $work 'export.inf'
  secedit /export /areas USER_RIGHTS /cfg $inf /quiet | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "secedit /export failed ($LASTEXITCODE)" }
  $current = @{}
  foreach ($line in Get-Content $inf) {
    if ($line -match '^(Se\w+)\s*=\s*(.*)$' -and $rights -contains $Matches[1]) {
      $current[$Matches[1]] = @($Matches[2] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }
  }
  $current
}

function Set-DenyRights([string[]]$Sids, [bool]$Deny, [string[]]$Which = $rights) {
  $work = Join-Path $env:TEMP "runner-rights-$PID"
  New-Item -ItemType Directory -Force $work | Out-Null
  try {
    $current = Get-DenyRights $work
    $tagged = @($Sids | ForEach-Object { "*$_" })
    $lines = foreach ($right in $Which) {
      $members = @($current[$right] | Where-Object { $_ -and $tagged -notcontains $_ })
      if ($Deny) { $members += $tagged }
      "$right = $($members -join ',')"
    }
    $inf = Join-Path $work 'rights.inf'
    @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1', '[Privilege Rights]') + $lines | Set-Content -Encoding Unicode $inf
    secedit /configure /db (Join-Path $work 'rights.sdb') /cfg $inf /areas USER_RIGHTS /log (Join-Path $work 'rights.log') /quiet | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Get-Content (Join-Path $work 'rights.log') -ErrorAction SilentlyContinue | Write-Host
      throw "secedit /configure failed ($LASTEXITCODE)"
    }
    # Read back: every SID in (or out of) each right changed.
    $after = Get-DenyRights $work
    foreach ($right in $Which) {
      foreach ($sid in $tagged) {
        if ((@($after[$right]) -contains $sid) -ne $Deny) { throw "$right still $(if ($Deny) { 'lacks' } else { 'has' }) $sid after secedit." }
      }
    }
  } finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  }
}

if (-not $Account) { $Account = @('ghrunner', 'ghmain') }
$users = @($Account | ForEach-Object { Get-LocalUser $_ -ErrorAction SilentlyContinue } | Where-Object { $_ })
if (-not $users) { throw "None of these local accounts exists: $($Account -join ', ')." }
$sids = @($users | ForEach-Object { $_.SID.Value })

if ($Release) {
  Step "Network logon allowed again for $($users.Name -join ', ') (until harden-runner.ps1 runs again)"
  Set-DenyRights $sids $false 'SeDenyNetworkLogonRight'
  return
}

Step "1/3 A password required for $($users.Name -join ', ')"
foreach ($u in $users) {
  net user $u.Name /passwordreq:yes | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "net user $($u.Name) /passwordreq:yes failed ($LASTEXITCODE)" }
  if (-not (Get-LocalUser $u.Name).PasswordRequired) { throw "$($u.Name) still doesn't require a password." }
}
Write-Host "Done."

Step "2/3 No local, Remote Desktop or network logon for $($users.Name -join ', ')"
# Their runner services log on as services, a right config.cmd granted and this leaves alone.
Set-DenyRights $sids $true
Write-Host "Done."

Step "3/3 The e2e browsers: changeable by administrators, SYSTEM and their runner's account only"
foreach ($b in $browsers) {
  $writer = Get-LocalUser $b.Writer -ErrorAction SilentlyContinue
  if (-not (Test-Path $b.Path)) { Write-Host "$($b.Path): not there, nothing to do."; continue }
  if (-not $writer) { Write-Host "$($b.Path): no $($b.Writer) account, left as it is."; continue }
  $grants = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', "*$($writer.SID.Value):(OI)(CI)M")
  if ($b.UsersRead) { $grants += '*S-1-5-32-545:(OI)(CI)RX' }
  icacls $b.Path /inheritance:r /grant:r @grants | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls $($b.Path) failed ($LASTEXITCODE)" }
  # Everything inside inherits exactly that (no ACE of its own left over).
  if (Get-ChildItem -Force $b.Path | Select-Object -First 1) {
    icacls "$($b.Path)\*" /reset /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls /reset under $($b.Path) failed ($LASTEXITCODE)" }
  }
  icacls $b.Path
}

Get-LocalUser $users.Name | Format-Table Name, Enabled, PasswordRequired -AutoSize
Write-Host "Done." -ForegroundColor Green
