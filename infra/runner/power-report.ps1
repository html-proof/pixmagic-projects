# What the PC did while a GitHub Actions job ran on it: step "Did the PC sleep during this job?" of
# the jobs that may land on the self-hosted runner (ci.yml checks and e2e). Read-only, and it
# never fails: it reads the System event log, which a service account may.
#
# The PC is a laptop with Modern Standby, where the screen turning off is the entry to standby:
# Kernel-Power event 506 ("entering Modern Standby", with the reason and whether the lid was open)
# and 507 ("exiting", with the duration and how much of it was DRIPS, the deepest idle, when the
# CPU runs nothing). On battery the PC then sleeps for real while a test's clock keeps running; on
# AC the screen goes off but the job runs on (its sleep timer on AC is "never"). The power request
# the job holds (keep-awake.ps1) doesn't prevent any of this: on 2026-10-20, with the request held
# for the whole job, the screen went off 120 s after the owner's last input, and the PC spent 279 s
# in DRIPS in the middle of the e2e suite, inside one test's 180 s budget. On battery the PC also
# runs a job 2-3 times slower (docs/aws-deployment.md, "The PC must be on and awake").
#
# So this step puts both into the job's own log: every standby that overlapped the job (a warning
# annotation: a test running then could only time out) and whether the job ran on battery (a
# notice). Run by the step with no arguments, it covers the job so far: from the start of the
# Runner.Worker process above it (found as keep-awake.ps1 finds it) to now. By hand, outside a job:
# -Since and -Until (UTC, e.g. 2026-10-20T06:07:30Z).
param(
  [string]$Since,
  [string]$Until
)
$ErrorActionPreference = 'Stop'

function Utc([datetime]$t) { $t.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
function Span([double]$seconds) {
  $s = [int][math]::Round($seconds)
  if ($s -ge 60) { return ('{0} min {1} s' -f [math]::Floor($s / 60), ($s % 60)) }
  return "$s s"
}
function Fields($event) {
  $d = @{}
  $xml = [xml]$event.ToXml()
  foreach ($e in $xml.Event.EventData.Data) { if ($e.Name) { $d[$e.Name] = $e.'#text' } }
  return $d
}

try {
  # ---- The window: the job so far, or the one asked for.
  $end = if ($Until) { ([datetime]$Until).ToUniversalTime() } else { (Get-Date).ToUniversalTime() }
  if ($Since) {
    $start = ([datetime]$Since).ToUniversalTime()
    $window = 'the window asked for'
  } else {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
    for ($i = 0; $p -and $i -lt 8 -and $p.Name -ine 'Runner.Worker.exe'; $i++) {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)"
    }
    if ($p -and $p.Name -ieq 'Runner.Worker.exe') {
      $start = $p.CreationDate.ToUniversalTime()
      $window = "this job (Runner.Worker.exe $($p.ProcessId) started then)"
    } else {
      $start = $end.AddHours(-1)
      $window = 'the last hour (no Runner.Worker.exe above this step)'
    }
  }
  Write-Host "Power events on this PC from $(Utc $start) to $(Utc $end), $window."

  # ---- Kernel-Power 506/507 (standby entered/left) and 105 (power source changed), from a day
  # before the window: a standby or a battery spell already under way when the job began counts.
  $events = @(Get-WinEvent -FilterHashtable @{
      LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 105, 506, 507
      StartTime = $start.AddHours(-24).ToLocalTime(); EndTime = $end.ToLocalTime()
    } -ErrorAction SilentlyContinue | Sort-Object TimeCreated, RecordId)

  # Pair each entry with the exit after it.
  $standbys = @()
  $enter = $null
  foreach ($ev in $events) {
    if ($ev.Id -eq 506) { $enter = $ev; continue }
    if ($ev.Id -ne 507) { continue }
    if ($enter) {
      $in = Fields $enter
      $out = Fields $ev
      $standbys += [pscustomobject]@{
        From = $enter.TimeCreated.ToUniversalTime(); To = $ev.TimeCreated.ToUniversalTime()
        Reason = $in['Reason']; LidOpen = $in['LidOpenState']
        Seconds = [double]$out['DurationInUs'] / 1e6; Drips = [double]$out['DripsResidencyInUs'] / 1e6
        OnBattery = ($out['PowerStateAc'] -eq 'false')
      }
    }
    $enter = $null
  }
  if ($enter -and $enter.TimeCreated.ToUniversalTime() -le $end) {
    $in = Fields $enter
    $standbys += [pscustomobject]@{
      From = $enter.TimeCreated.ToUniversalTime(); To = $end; Reason = $in['Reason']; LidOpen = $in['LidOpenState']
      Seconds = ($end - $enter.TimeCreated.ToUniversalTime()).TotalSeconds; Drips = 0; OnBattery = $null; Open = $true
    }
  }
  $during = @($standbys | Where-Object { $_.To -ge $start -and $_.From -le $end })

  # ---- Battery or AC: the last change before the window, the changes inside it, or the state now.
  $battery = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
  $changes = @($events | Where-Object { $_.Id -eq 105 })
  $before = @($changes | Where-Object { $_.TimeCreated.ToUniversalTime() -lt $start }) | Select-Object -Last 1
  $inside = @($changes | Where-Object { $_.TimeCreated.ToUniversalTime() -ge $start -and $_.TimeCreated.ToUniversalTime() -le $end })
  $acAtStart = $null
  if ($before) { $acAtStart = ((Fields $before)['AcOnline'] -eq 'true') }
  elseif ($inside.Count -gt 0) { $acAtStart = -not ((Fields $inside[0])['AcOnline'] -eq 'true') }
  elseif ($battery) { $acAtStart = ($battery.BatteryStatus -ne 1) }  # 1 = discharging

  # ---- Report.
  if ($during.Count -eq 0) {
    Write-Host 'Modern Standby: not entered during this window.'
  } else {
    Write-Host "Modern Standby entered $($during.Count) time(s) during this window:"
    $asleep = 0
    foreach ($s in $during) {
      $why = switch ($s.Reason) { '12' { 'the screen-off timer ran out' } '15' { 'the lid was closed' } default { "reason $($s.Reason)" } }
      if ($s.LidOpen -eq 'false' -and $s.Reason -ne '15') { $why += ', lid closed' }
      $power = if ($s.OnBattery -eq $true) { 'on battery' } elseif ($s.OnBattery -eq $false) { 'plugged in' } else { '' }
      $still = if ($s.Open) { ' and not left yet' } else { '' }
      $line = "  $(Utc $s.From) to $(Utc $s.To): $(Span $s.Seconds)$still, $(Span $s.Drips) of it in DRIPS (nothing runs); $why"
      if ($power) { $line += "; $power" }
      Write-Host $line
      $asleep += $s.Drips
    }
    # Plugged in, the screen goes off and the job runs on; it is DRIPS time that stalls a job.
    if ($asleep -gt 0) {
      Write-Host ("::warning::The PC entered Modern Standby {0} time(s) during this job and spent {1} of it in DRIPS, when nothing runs: a test running then could only time out. The job's power request doesn't prevent it; the owner's power settings do (docs/aws-deployment.md, 'The PC must be on and awake')." -f $during.Count, (Span $asleep))
    } else {
      Write-Host 'The screen went off, but the PC stayed active throughout (no DRIPS): the job ran on.'
    }
  }

  if (-not $battery) {
    Write-Host 'Power source: no battery (not a laptop).'
  } else {
    $onBatteryEver = ($acAtStart -eq $false)
    $parts = @()
    if ($acAtStart -eq $true) { $parts += 'plugged in at the start' } elseif ($acAtStart -eq $false) { $parts += 'on battery at the start' }
    foreach ($c in $inside) {
      $ac = ((Fields $c)['AcOnline'] -eq 'true')
      if (-not $ac) { $onBatteryEver = $true }
      $parts += "$(if ($ac) { 'plugged in' } else { 'unplugged' }) at $(Utc $c.TimeCreated)"
    }
    $now = if ($battery.BatteryStatus -eq 1) { "on battery now, $($battery.EstimatedChargeRemaining)% left" } else { "plugged in now, $($battery.EstimatedChargeRemaining)%" }
    $parts += $now
    Write-Host "Power source: $($parts -join '; ')."
    if ($onBatteryEver) {
      Write-Host '::notice::This job ran on battery for all or part of its time. On battery this PC runs a job 2-3 times slower, and 3 minutes after the last input its screen goes off and it sleeps (Modern Standby), whatever power requests are held. Plug it in while jobs run (docs/aws-deployment.md).'
    }
  }
} catch {
  Write-Host "power-report.ps1 could not read the power events: $($_.Exception.Message)"
}
exit 0
