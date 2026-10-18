# Locks down the PC's GitHub Actions runner accounts and the folders their jobs run code from: the
# owner-run half of "Hardening the runner" in docs/aws-deployment.md. install-runner.ps1 runs it for
# the account it creates; run it by hand once for a runner installed before it existed. Safe to run
# again.
#
# Run it in an elevated Windows PowerShell (right-click Windows PowerShell > Run as administrator):
#   powershell -ExecutionPolicy Bypass -File <this file>
#
#   1. Folders, owned by Administrators (runner-folders.ps1 refuses one someone else made first):
#      - C:\node_modules, read-only to users. Node looks there for any package a project lacks
#        (vite asks for fsevents, which Windows never installs), and any account may create
#        folders at C:\: a planted one would run inside every test and deploy job.
#      - The e2e browsers (PW_BROWSERS, ci.yml): C:\ms-playwright changeable by ghrunner (it
#        downloads new browser builds), readable by users; C:\ms-playwright-main (the runner for
#        main's) the same with ghmain, readable by no one else. C:\ passes "Authenticated Users:
#        Modify" down to new folders, so any account could otherwise swap the chrome.exe a runner starts.
#      - The runner for main's job hook folder, C:\ProgramData\bizinsights-runner, if there.
#   2. For each runner account (ghrunner and ghmain, those that exist; or the ones -Account names):
#      a password is required (New-LocalUser leaves "password not required", PASSWD_NOTREQD, set).
#   3. And no logon but as its service: local, Remote Desktop and network logon denied.
#
# -Release allows the -Account accounts network logon again, and nothing else: config.cmd checks
# the password with one, so install-runner.ps1 lifts that denial while it registers a runner, then
# puts it back.
#Requires -RunAsAdministrator
param(
  [string[]]$Account,
  [switch]$Release
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runner-folders.ps1')

$rights = 'SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight', 'SeDenyNetworkLogonRight'

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Get-AccountSid([string]$Name) { $u = Get-LocalUser $Name -ErrorAction SilentlyContinue; if ($u) { $u.SID.Value } }

# secedit names local accounts by name and others by *SID: everything as *SID, so lists compare.
function ConvertTo-SidEntry([string]$Member) {
  if ($Member.StartsWith('*')) { return $Member }
  try { '*' + (New-Object System.Security.Principal.NTAccount $Member).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $Member }
}

# The three rights as secedit exports them: right name -> its members, as *SID where possible.
function Get-DenyRights($work) {
  $inf = Join-Path $work 'export.inf'
  secedit /export /areas USER_RIGHTS /cfg $inf /quiet | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "secedit /export failed ($LASTEXITCODE)" }
  $current = @{}
  foreach ($line in Get-Content $inf) {
    if ($line -match '^(Se\w+)\s*=\s*(.*)$' -and $rights -contains $Matches[1]) {
      $current[$Matches[1]] = @($Matches[2] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ } | ForEach-Object { ConvertTo-SidEntry $_ })
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

Step "1/3 Folders the jobs run code from: owned by Administrators"
$ghrunner = Get-AccountSid 'ghrunner'
$ghmain = Get-AccountSid 'ghmain'
Set-LockedFolder -Path 'C:\node_modules' -UsersRead
Write-Host "C:\node_modules: users may read it, no one but administrators may change it."
if ((Test-Path 'C:\ms-playwright') -and $ghrunner) {
  Set-LockedFolder -Path 'C:\ms-playwright' -Modify $ghrunner -UsersRead -AllowedOwners $ghrunner
  Write-Host "C:\ms-playwright: ghrunner may change it, users may read it."
}
if ((Test-Path 'C:\ms-playwright-main') -and $ghmain) {
  Set-LockedFolder -Path 'C:\ms-playwright-main' -Modify $ghmain -AllowedOwners $ghmain
  Write-Host "C:\ms-playwright-main: only ghmain may change or read it."
}
if ((Test-Path 'C:\ProgramData\bizinsights-runner') -and $ghmain) {
  Set-LockedFolder -Path 'C:\ProgramData\bizinsights-runner' -ReadExecute $ghmain
  Write-Host "C:\ProgramData\bizinsights-runner: ghmain may read it."
}

Step "2/3 A password required for $($users.Name -join ', ')"
foreach ($u in $users) {
  net user $u.Name /passwordreq:yes | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "net user $($u.Name) /passwordreq:yes failed ($LASTEXITCODE)" }
  if (-not (Get-LocalUser $u.Name).PasswordRequired) { throw "$($u.Name) still doesn't require a password." }
}
Write-Host "Done."

Step "3/3 No local, Remote Desktop or network logon for $($users.Name -join ', ')"
# Their runner services log on as services, a right config.cmd granted and this leaves alone.
Set-DenyRights $sids $true
Write-Host "Done."

Get-LocalUser $users.Name | Format-Table Name, Enabled, PasswordRequired -AutoSize
Write-Host "Done." -ForegroundColor Green
