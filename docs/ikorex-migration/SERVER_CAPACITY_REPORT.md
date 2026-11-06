# iKorex server capacity

**Status (2026-11-06): the server side is not measured yet.** This PC has no SSH key for the server,
so nobody has logged in. What is known, what bizinsights needs, and the test that decides whether it
fits.

## What is known about the server

| Item | Value | Source |
| --- | --- | --- |
| Address | 103.146.112.176, SSH on port 22 | SSH guide (PDF, 5 Nov 2026) |
| Account | `deployer`, SSH keys only, no passwords | Guide |
| Host key | ED25519 `SHA256:5whPPmUOtct7uImi8hLLqyVU5vv1j470FAfLI5Or+TA` | Guide; **matched** by `ssh-keyscan` from this PC on 2026-11-06 |
| Brute-force protection | An address is blocked for 1 hour after 5 failed logins in 10 minutes | Guide |
| Already running | Live websites, n8n, a CCTV tunnel, all under `deployer` | Guide |
| Administrator's condition | "check with me before changing anything on the server" | Guide |
| CPU, memory, disk, OS, Docker, ports, load | **Unknown** | Needs a login |

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
