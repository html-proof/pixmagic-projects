# Folders the runners' jobs run code from, which only administrators may own: dot-sourced by
# install-runner.ps1 and harden-runner.ps1 (elevated). A standard account can create folders at C:\
# and in C:\ProgramData, and whoever owns a folder can always rewrite its permissions, so a folder
# someone else made first is refused rather than reused: it may hold planted files.

$script:AdminSid = 'S-1-5-32-544'
$script:SystemSid = 'S-1-5-18'
$script:UsersSid = 'S-1-5-32-545'

function Get-OwnerSid([string]$Path) {
  (Get-Acl -LiteralPath $Path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
}

# Creates $Path (or takes over one that $AllowedOwners or an administrator already own) with
# Administrators as owner of it and everything in it, and exactly these grants: SYSTEM and
# Administrators full control, $Modify modify, and users read when -UsersRead. Reads it back.
function Set-LockedFolder {
  param(
    [Parameter(Mandatory)][string]$Path,
    [string[]]$Modify = @(),
    [string[]]$ReadExecute = @(),
    [switch]$UsersRead,
    [string[]]$AllowedOwners = @()
  )
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if (Test-Path -LiteralPath $Path) {
    $owner = Get-OwnerSid $Path
    if (@($script:AdminSid, $script:SystemSid, $me) + $AllowedOwners -notcontains $owner) {
      $name = try { (New-Object System.Security.Principal.SecurityIdentifier $owner).Translate([System.Security.Principal.NTAccount]).Value } catch { $owner }
      throw "$Path already exists and belongs to $name, not to an administrator: it may hold planted files. Look at what is in it, delete it in an elevated Command Prompt (rmdir /s /q `"$Path`"), then run this again."
    }
  } else {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
  $grants = @("*$($script:SystemSid):(OI)(CI)F", "*$($script:AdminSid):(OI)(CI)F")
  $grants += $Modify | ForEach-Object { "*$($_):(OI)(CI)M" }
  $grants += $ReadExecute | ForEach-Object { "*$($_):(OI)(CI)RX" }
  if ($UsersRead) { $grants += "*$($script:UsersSid):(OI)(CI)RX" }
  icacls $Path /setowner "*$($script:AdminSid)" /T /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls /setowner on $Path failed ($LASTEXITCODE)" }
  icacls $Path /inheritance:r /grant:r @grants | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls $Path failed ($LASTEXITCODE)" }
  # Everything inside inherits exactly that (no ACE of its own left over).
  if (Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1) {
    icacls "$Path\*" /reset /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls /reset under $Path failed ($LASTEXITCODE)" }
  }
  # Read back: the owner, and no one else allowed in.
  $acl = Get-Acl -LiteralPath $Path
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $script:AdminSid) { throw "$Path isn't owned by Administrators after icacls." }
  $expected = @($script:SystemSid, $script:AdminSid) + $Modify + $ReadExecute + $(if ($UsersRead) { $script:UsersSid })
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $expected -notcontains $rule.IdentityReference.Value) {
      throw "$Path still lets $($rule.IdentityReference.Value) in after icacls."
    }
  }
}
