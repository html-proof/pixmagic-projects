# iKorex server capacity

**Status (2026-11-08): measured once; no go on memory as the server is today.** The first
inspection ran on 2026-11-08 ([below](#inspection-2026-11-08)). The server is healthy but has 3.8 GB
of memory in all, 2.5 GB of it free next to what already runs there, and bizinsights alone needs
3.2–4.6 GB. The owner chose to ask the administrator to enlarge it to at least 8 GB and 4 cores
rather than take a server of its own. The inspection runs again after the resize, and nothing is
installed before it passes. What is known, what bizinsights needs, the test that decides, and its
first result.

## What is known about the server

| Item | Value | Source |
| --- | --- | --- |
| Address | 103.146.112.176, SSH on port 22 | SSH guide (PDF, 5 Nov 2026) |
| Account | `deployer`, SSH keys only, no passwords | Guide |
| Host key | ED25519 `SHA256:5whPPmUOtct7uImi8hLLqyVU5vv1j470FAfLI5Or+TA` | Guide; **matched** by `ssh-keyscan` from this PC on 2026-11-06 |
| Brute-force protection | An address is blocked for 1 hour after 5 failed logins in 10 minutes | Guide |
| Already running | Live websites, n8n, a CCTV tunnel, all under `deployer`: 12 containers in 6 Compose projects | Guide; inspection 2026-11-08 |
| Administrator's condition | "check with me before changing anything on the server" | Guide |
| First login | 2026-11-08, this PC's key (installed by the administrator; its passphrase typed by the owner, no `ssh-agent`) | `ssh … "hostname; whoami; uptime"`: `ikorex.production.com.au`, `deployer`, up 32 days |
| CPU, memory, disk, OS, Docker, ports, load | 2 cores, 3.8 GB, 45 GB free, Ubuntu 24.04, Docker 29.8 | [Inspection, 2026-11-08](#inspection-2026-11-08) |

## What bizinsights needs

From the AWS workload of the 7 days to 2026-11-06 (CloudWatch):

| Measure | AWS today |
| --- | --- |
| API requests | 45,811 a week (~0.08 a second on average), 121 ms average |
| Background jobs | 34,719 a week, 572 ms average: ~5.5 CPU-hours a week, ~3 % of one core on average, bursts during Shopify backfills |
| Scheduled runs | 798 a week, 5.1 s average |
| Database | 1.8 GB used; CPU 6 % daily average, 55 % highest 5-minute peak on 2 burstable vCPUs; up to 32 connections; **out of memory on its 1 GB** (84 MiB free at the lowest) |
| WhatsApp service | 0.5 vCPU + 1 GB reserved |
| Logs | 146 MB stored over 90 days |

Translated into containers on one server:

| Container | Expected use | Limit set |
| --- | --- | --- |
| `app` | 250–400 MB, under 5 % of a core | 768 MB, 1 CPU |
| `worker` | 400–700 MB; 1–2 cores during backfills | 1.5 GB, 2 CPU |
| `postgres` | 1–1.5 GB (more memory than RDS has today, which is what it needs) | 2 GB, 2 CPU |
| `evolution` | 300–600 MB | 1 GB, 1 CPU |
| `cloudflared`, `backup` (the weekly restore test runs a second, small PostgreSQL) | ~150 MB, ~400 MB during the test | 896 MB |
| monitoring | 0.8–1.2 GB | 1.5 GB |
| **Total** | **~3.2–4.6 GB** | **~7.3 GB of limits** (not all used at once) |

Disk: ~2 GB database + ~1 GB write-ahead log + ~3 GB images + logs and local backup staging:
**~10 GB today**, growing with the stores' order history.

## The test that decides

Measured on the server at its busiest time of day (the inspection script below, run twice: once
during business hours):

| | Go | Tight: go without Loki/Grafana, review in a month | No go |
| --- | --- | --- | --- |
| Memory available (`free -m`, "available") | ≥ 6 GB | 4–6 GB | < 4 GB |
| CPU | ≥ 4 cores, load average < 50 % of cores | 2–3 cores, load < 40 % | 1 core, or load > 70 % |
| Free disk, SSD | ≥ 40 GB | 25–40 GB | < 25 GB, or spinning disk only |
| Docker | Engine ≥ 24 with Compose v2 | Older Engine the administrator agrees to upgrade | No Docker and no agreement to install it |
| Outbound HTTPS | Open | — | Blocked |

**No go** means bizinsights would put the websites, n8n or the CCTV tunnel at risk. Then the
alternative is a server of its own (a 4 vCPU / 8 GB / 80 GB SSD virtual server; prices to be quoted),, with the same design, or staying on AWS with the cost plan in
[../aws-migration/AWS_MIGRATION_PLAN.md](../aws-migration/AWS_MIGRATION_PLAN.md) (about US$76–90 a
month with GST).

## Inspection, 2026-11-08

[inspect-server.sh](inspect-server.sh), run once from the owner's PC on Sunday 2026-11-08 at 17:45
Melbourne time (AEDT; the server's clock is on `Australia/Melbourne` and synchronised). It changed
nothing. The output stayed on the PC, outside the repository; what matters is below. It was a quiet
hour, while the test asks for a busy one too. That run isn't needed for this verdict: the shortfall
is the server's total memory, which a busier hour can only make worse.

| | Measured | Verdict |
| --- | --- | --- |
| Memory available | **2,518 MB** of 3,914 MB. 1,396 MB used: n8n ~390 MB, the rest by the websites, the CCTV services and Docker itself. Swap: 6 GB, 35 MB used | **No go** (under 4 GB) |
| CPU | 2 virtual cores (AMD EPYC 9254, KVM). Load average 0.08–0.45, 95–99 % idle over 5 seconds | Tight (2–3 cores, load under 40 %) |
| Free disk | 45 GB of 73 GB (ext4). Docker's build cache holds 8.3 GB more that could be reclaimed. Whether the disk is SSD isn't shown (a virtual disk reports "rotational" whatever is under it): the administrator to confirm | Go, if SSD |
| Docker | Engine 29.8.2, Compose v5.6.0 | Go |
| Outbound HTTPS | Not checked by this run; the script checks it from now on | — |

**Verdict: no go as the server is today.** bizinsights' containers need 3.2–4.6 GB together
([above](#what-bizinsights-needs)). That is more than the server has free, and close to all the memory it has. Seven
of its twelve containers have no memory limit (n8n and its database, the websites, the gateway), so
a shortage would fall on any of them, the CCTV services included.

**What passes:** at least 8 GB and 4 cores. With ~1.4 GB used by what runs today, 8 GB leaves
~6.5 GB available, the "go" line. 6 GB with 2–3 cores would be "tight": go without Loki and Grafana,
review in a month.

**The owner's decision (2026-11-08):** ask the administrator to resize the server rather than take
a server of its own. The request sent covers the size (at least 8 GB and 4 cores, the disk as it
is), the cost and the time; one restart could also apply the pending updates. It also asks for a
separate Linux user for bizinsights (O1/O2 below) and passes on the findings below. If the
administrator can't, the alternative stays the one in [the test](#the-test-that-decides): a server
of its own with the same files.

**What already runs**, for the "keep working" criteria (19, 20 in
[MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md#acceptance-criteria-the-briefs-22)): the CCTV
services (5 containers, each with a memory limit, among them a STUN/TURN server on port 3478), the
iKorex websites (4 containers: an app, a portal, a staging copy, the official website), a gateway
(nginx on ports 80 and 443), and n8n with its PostgreSQL 16. Listening on every address: 22, 80, 443
and 3478 (which of them the firewall lets in wasn't readable without `sudo`). bizinsights adds no
port: its traffic comes through the Cloudflare tunnel, which only connects outwards.

### The security audit's open items

Answers to [SECURITY_AUDIT.md](SECURITY_AUDIT.md#open)'s server questions, as far as a read-only
look without `sudo` gives them:

| Item | Found | Left open |
| --- | --- | --- |
| O1: the `docker` group | Only `deployer` is in it. `deployer` is also in `sudo` (with a password) | Anything running as `deployer` controls every container. Asked for: a separate Linux user, and rootless Docker for it, which is the administrator's call |
| O2: other programs as `deployer` | Processes with `deployer`'s user id (1000), besides the inspection's own: `node` (3), `MainThread` (2, the largest at ~320 MB), and `docker-init` (3) and `tini`, which are containers' first processes. So some containers run with the same id, and they see only what is mounted into them | Which are programs on the host: a separate user settles it either way |
| O3: files every user can read | Under `deployer`'s home: 4 `.env` files and 3 key files (counts only). The home folder itself is closed to other users (`drwxr-x---`) | Told to the administrator |
| O4: disk encryption | None (no `crypto_LUKS`) | The administrator's call. bizinsights' backups are encrypted either way |
| O5: patching, SSH, firewall | Automatic security updates on; fail2ban on; password and keyboard-interactive logins off. A restart is pending with 27 updates waiting. `PermitRootLogin` appears as both `yes` and `no` across the SSH settings files | The effective root-login setting (`sudo sshd -T`) and the firewall rules (`ufw`) need `sudo`: asked of the administrator |

## When one server stops being enough

Measured signs, each with an alert: database memory pressure (cache hit ratio < 99 %), worker queue
latency > 5 minutes for an hour, CPU > 70 % for a day, disk > 70 %. The order to grow: more memory
for PostgreSQL, a second worker container, then PostgreSQL on its own server, then the workers. A
claim of how many stores one server holds needs a load test against staging first; none has been
run.

## Inspecting the server

[inspect-server.sh](inspect-server.sh) reads the facts above and changes nothing: no installs,
restarts or writes, no environment variables or config contents printed, sudo only tried with `-n`
(never prompts) for read-only status. Once this PC's key is on the server, from the repository's
folder. In Git Bash:

```
ssh deployer@103.146.112.176 'bash -s' < docs/ikorex-migration/inspect-server.sh > ikorex-inventory.txt
```

In PowerShell 5.1, which has no `<`, through `cmd` (it passes the file through unchanged):

```
cmd /c "ssh deployer@103.146.112.176 bash -s < docs\ikorex-migration\inspect-server.sh > ikorex-inventory.txt"
```

Run it at most once or twice in a row: each SSH connection counts toward the server's
5-failures-in-10-minutes block if the key is refused.

The key has a passphrase. Without `ssh-agent` (its Windows service is off on the owner's PC), `ssh`
asks for it in the terminal, through `cmd /c` too. The server drops a login left waiting for about
two minutes, so type it soon. Add `-o IdentitiesOnly=yes -i C:\Users\Seban\.ssh\id_ed25519` so `ssh`
offers only that key.
