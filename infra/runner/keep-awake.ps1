# Keeps the PC awake while a GitHub Actions job runs on it: step "Keep the PC awake for this job" of
# the jobs that may land on the self-hosted runner (ci.yml checks and e2e, aws-deploy.yml deploy).
#
# The PC is a laptop with Modern Standby. Unplugged, it turns the screen off and sleeps 3 minutes
# after the last input (powercfg VIDEOIDLE and STANDBYIDLE are 180 s on battery; on AC the screen
# goes off after 120 s and it never sleeps), and asleep it drops the network and does no work while
# a test's clock keeps running. On 2026-10-19 a 78 s sleep in the middle of `pnpm test:integration`
# failed test/shopify.test.ts with "Hook timed out in 60000ms" (its beforeEach, resetDb, was in
# flight), and earlier sleeps lost whole jobs ("The self-hosted runner lost communication with the
# server").
#
# Run by the step with no arguments, it finds the job's Runner.Worker process above itself, starts
# a second copy of itself detached, following that process, and returns at once (a child that
# inherited the step's output pipe would hold the step open until it ended). The detached copy asks
# Windows to keep the system and the display on (SetThreadExecutionState: a power request, which
# `powercfg /requests` lists under this powershell.exe) until that process is gone, i.e. the job is
# over. The runner's own clean-up kills it with the job as well (it ends every process carrying the
# job's RUNNER_TRACKING_ID), and it gives up by itself after 3 hours, longer than any job's
# timeout-minutes. By hand, outside a job, `-Worker <pid>` names the process to follow.
#
# What it has not done: on 2026-10-20, with the request held for the whole of two e2e jobs (the
# runner ended the holder with each job, as the job logs show), the screen still went off 120 s
# after the owner's last input, and the PC, on battery, spent 279 s in DRIPS in the middle of the
# suite. Held from the runner's service session, not the signed-in user's, the request evidently
# doesn't reset this Modern Standby laptop's screen-off timer, and the screen going off is its way
# into standby. A closed lid sleeps it as well, whatever is held. What does keep it awake while
# jobs run is the owner's power settings (docs/aws-deployment.md, "The PC must be on and awake");
# power-report.ps1, the last step of each job on the PC, shows in the job's log when it slept anyway.
param(
  # Hold the request (the detached copy) rather than start it.
  [switch]$Hold,
  # The process whose end releases the request: found by the first copy, or given by hand.
  [int]$Worker = 0
)
$ErrorActionPreference = 'Stop'

if (-not $Hold) {
  if ($Worker) {
    $until = "$((Get-Process -Id $Worker).ProcessName) ($Worker) ends"
  } else {
    # Walk up from this process to the job's Runner.Worker; the step's shell (Git Bash, two or three
    # processes) sits in between.
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
    for ($i = 0; $p -and $i -lt 8 -and $p.Name -ine 'Runner.Worker.exe'; $i++) {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)"
    }
    if ($p -and $p.Name -ieq 'Runner.Worker.exe') {
      $Worker = $p.ProcessId
      $until = "$($p.Name) ($Worker) ends"
    } elseif ($env:GITHUB_ACTIONS -eq 'true') {
      # Still released: by the runner's clean-up at the end of the job, or by the 3-hour cap.
      Write-Host "::warning::keep-awake.ps1 found no Runner.Worker.exe above this step; the runner's job clean-up releases the request."
      $until = 'the job ends'
    } else {
      throw 'Outside a job, pass -Worker <pid>: the process whose end releases the request.'
    }
  }
  # Start-Process joins the arguments with spaces and quotes nothing, hence the quotes.
  $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', "`"$PSCommandPath`"", '-Hold', '-Worker', $Worker)
  $child = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru
  Write-Host "Keeping the PC awake until ${until}: powershell.exe $($child.Id)."
  exit 0
}

# The flags are combined in C#: Windows PowerShell reads 0x80000000 as a negative Int32.
$kernel32 = Add-Type -Namespace BizInsights -Name KeepAwake -PassThru -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
static extern uint SetThreadExecutionState(uint esFlags);
const uint ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x1, ES_DISPLAY_REQUIRED = 0x2;
/// Keep the system and the display on until this thread ends; false when Windows refused.
public static bool Hold() { return SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) != 0; }
'@
# The request lives as long as this thread does (ES_CONTINUOUS), and this script runs on one thread.
if (-not $kernel32::Hold()) { throw 'SetThreadExecutionState refused the power request.' }
$deadline = (Get-Date).AddHours(3)
while ((Get-Date) -lt $deadline) {
  if ($Worker -and -not (Get-Process -Id $Worker -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 20
}
