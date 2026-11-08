# Security audit: bizinsights on the iKorex server

**Status (2026-11-07):** an audit of the design and of every file that will run on the server
(stage A's runtime and server files, and the database copy). Six findings are fixed in the same
change, with tests. The server itself has not been inspected yet (SSH access waits for its
administrator), so what only the server can answer is listed under [Open](#open), with the check
that answers it. Like the rest of the migration, nothing is claimed that hasn't been run.

## What was audited, and how

- `infra/ikorex/`: both Compose projects, the two images, the scripts (`deploy.sh`, `ship.sh`,
  `render-monitoring.sh`, `export-env.mjs`, `copy-db.*`), every `env/*.example`, the monitoring
  and backup settings.
- The self-hosted runtime in `apps/aws/src` (`selfhost.ts` and its parts, `sqsBridge.ts`), which
  runs the same application code as on AWS.
- Against the brief's rules: isolation from the websites, n8n and the CCTV tunnel; no public
  PostgreSQL, Redis, MinIO or internal ports; no secrets in Git or logs; no plaintext password
  moves; no mass session invalidation; nothing disruptive without approval.
- Compose's own rendering of the files (`docker compose config`, every profile included) is
  checked by `apps/aws/test/ikorexCompose.test.ts` on each CI run, so the properties below can't
  quietly drift.

## Fixed in this change

| # | Finding | Severity | Fix | Proof |
| --- | --- | --- | --- | --- |
| F1 | `postgres`, `backup`, `evolution` and all seven monitoring containers kept Docker's default Linux capabilities (14, `NET_RAW`, `SETUID` and `DAC_OVERRIDE` among them); only the app's containers and the tunnel dropped them | Medium | Every container drops all of them; `postgres` gets back the five its entrypoint needs to own its data folder and become `postgres` (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`) | `ikorexCompose.test.ts`: every service of both projects `cap_drop: [ALL]`, `cap_add` only those five on `postgres` |
| F2 | `deploy.sh` and `render-monitoring.sh` accepted settings files still holding the `CHANGE_ME` placeholders of their examples, so the system role's, the tenant role's, the monitoring login's or Grafana's admin password could go live as a value anyone can read on GitHub | Medium | Both refuse to run while any `env/*.env` holds `CHANGE_ME`, naming the files | `ikorexCompose.test.ts`: both scripts exit 1 on the examples as copied, before anything runs |
| F3 | The monitoring containers' filesystems were writable | Low | Prometheus, Alertmanager and both exporters read-only (they write only to their volumes; `/tmp` in memory) | `ikorexCompose.test.ts` |
| F4 | `ship.sh` trusted whatever host key the PC's `known_hosts` held for the server | Medium | The server's host key is pinned in `infra/ikorex/known_hosts`; `ship.sh` and `copy-db.mjs` connect only to it (`StrictHostKeyChecking=yes`), `copy-db.mjs` checks its fingerprint against the guide's before connecting, and a test does the same | `copy-db-lib.test.mjs`: the file's fingerprint is `SHA256:5whPPmUOtct7uImi8hLLqyVU5vv1j470FAfLI5Or+TA`, the guide's (also matched by `ssh-keyscan` on 2026-11-06) |
| F5 | The database copy had no defined path: the move to AWS went through a backup on the PC's disk | Medium | The copy never lands on the PC: RDS → AWS's admin host → an encrypted bucket prefix the host may only write to and that empties itself in a day → a one-hour link on stdin → the server. Reports hold counts only ([DATABASE_MIGRATION_REPORT.md](DATABASE_MIGRATION_REPORT.md)) | `copyDb.test.ts`, the CDK test for `db-export/` |
| F6 | The two files `render-monitoring.sh` writes (the alert address, Resend's SMTP password) weren't ignored by Git, and `ship.sh` would have sent a local copy over the server's | Low | Both ignored, and left out of what `ship.sh` sends | `git check-ignore` |

These settings take effect when the containers first run on the server (stage B), and that first
start is their test: every container healthy, `postgres` included with its five capabilities.

## By design (checked, accepted)

| # | What | Why it is acceptable |
| --- | --- | --- |
| D1 | No published port on any container, no host networking, no privileged container | Tested (`ikorexCompose.test.ts`). The public reaches only `web:8080`, through the Cloudflare Tunnel, which dials out. PostgreSQL, the metrics ports, Grafana, Prometheus and the WhatsApp service are on the Compose network only |
| D2 | The Docker socket | Mounted nowhere except the optional log collector (Alloy, `logs` profile, off by decision 7), read-only. Turning it on needs the administrator's agreement: the socket is root on the host |
| D3 | PostgreSQL listens on the Compose network | Every network login needs its password (SCRAM, the official image's rule when `POSTGRES_PASSWORD` is set); the local socket is shared only with the `backup` container. Containers of the monitoring project can reach it, with the read-only `monitor` login (`pg_monitor`: statistics, no table data) |
| D4 | The database owner on the server is a superuser (RDS's master isn't) | Only the one-off `admin` container is given its login. The web and worker roles log in as `app_rls` and `app_system`, neither superuser nor `BYPASSRLS`, so row-level security applies to every request; `migrate` refuses to finish if `app_system` is either |
| D5 | The client's address comes from `CF-Connecting-IP` | Believed only in that header and in a valid format; only `cloudflared` and the monitoring containers can reach `web:8080` at all |
| D6 | node-exporter sees the host's processes and reads its filesystem, read-only | The standard way to measure the host's memory, CPU and disk, which the alerts need. It serves numbers only, but it could read any file on the host that every user may read: the administrator was told (the access request), and the inspection counts such files (O3) |
| D7 | Secrets on the server | In `env/*.env`, mode 600, never in Git (`.gitignore` and `ship.sh` exclude them); `export-env.mjs` writes them straight into the server's file over SSH and refuses a terminal; the owner's database login is in the `admin` container only; Alertmanager's SMTP password in a file only it mounts |
| D8 | Secrets in logs | The same application logger as on AWS; the WhatsApp service's console filtered to its own logger (`evolution/start.sh`: its stray logs print messages and Signal keys); the copy and export scripts print names, counts and checksums only |
| D9 | Customer sessions | Not invalidated: the sessions are database rows that the copy carries, signed with the same secret (`export-env.mjs` copies the app secret), and so are the app's own sign-in tokens (`auth_refresh_tokens` rows; JWTs from the same secret). Sessions still on Cognito's tokens keep working while Cognito runs (until stage F). Checked at cutover step 6 (O6) |
| D10 | Passwords | None moves in plaintext: the app's own sign-in keeps only argon2id hashes (`auth_accounts`), copied with the database; Cognito keeps the passwords of those who haven't moved over, until stage F; the database roles get new ones on the server; the WhatsApp service's API key is copied straight into its settings file over SSH |
| D11 | Backups | pgBackRest encrypts every backup and WAL segment (AES-256) before it leaves; the passphrase is kept off the server; the R2 token is limited to its one bucket; a weekly restore test |
| D12 | Edge protection | AWS WAF goes with AWS; Cloudflare's free managed rules and a rate-limiting rule stand in front, and the app's own per-IP and per-route limits stay. Less than AWS's managed groups (the matrix says so); accepted with the move |
| D13 | SSH | Keys only, fail2ban after 5 failures (the guide). The PC's key has a passphrase (added by the owner 2026-11-07); its private half never leaves the PC: not in Git, not in GitHub's secrets, not on the runner. Deploys to the server go from the PC by hand until a separate deploy key is agreed with the administrator. That key's workflow is built and off (Deploy to iKorex, 2026-11-07): a key of its own, kept only in the GitHub environment `ikorex`'s secret and given only to the job that installs nothing; on the server its line is `restrict,command=` to `ssh-gate.sh` (receive a release, deploy it, nothing else); it connects only to the pinned host key. It can still deploy, which is root through Docker (O1), so deleting its line revokes it ([PRODUCTION_DEPLOYMENT_GUIDE.md](PRODUCTION_DEPLOYMENT_GUIDE.md#deploy-to-ikorex-github-actions)) |

## Open

Answered by the read-only inspection (`inspect-server.sh`, whose "security settings" section was
added for these), the administrator, or the stage named.

| # | Question | Risk if the answer is bad | How it gets answered |
| --- | --- | --- | --- |
| O1 | **Who else is in the `docker` group, and what runs as `deployer`?** Docker's daemon is shared with the websites, n8n and the CCTV tunnel; any member of that group controls every container on the host, bizinsights' database included | High: a compromise of anything running as a docker-group user reaches all customer data | Inspection: docker group members, programs running as `deployer`. The administrator: question 2 of the access request (a separate Linux user). A separate user still in the docker group is no barrier; rootless Docker for that user would be, and is the administrator's call |
| O2 | **Can other programs running as `deployer` read bizinsights' settings files?** Mode 600 protects them from other users, not from the same one | High: the Shopify, Meta and Google secrets, the token encryption key and the database passwords | Same as O1: a separate Linux user, or nothing else running as `deployer` |
| O3 | Files on the host that every user can read (`.env`, keys) | Medium: node-exporter (D6) and every other user could read them | Inspection: counts only, never names or contents; told to the administrator |
| O4 | The server's disk encryption | Medium: RDS's storage is encrypted at rest; a copy of the server's disk would hold the data in clear (backups are encrypted either way) | Inspection: `lsblk` (`crypto_LUKS`); otherwise the administrator's call, recorded here |
| O5 | Operating system patching, sshd's password and root logins, the firewall | Medium | Inspection: unattended upgrades, the sshd settings, `ufw` (if `sudo -n` allows), reboot pending |
| O6 | Customer sessions survive the move | Medium: everyone signed out | Cutover step 6: a session made on AWS still works after the DNS moves |
| O7 | Image tags are not pinned by digest (only the WhatsApp service's is) | Medium: a re-pushed tag would change what runs | Stage B: after the first pull, each image pinned by digest in the Compose files, like Evolution's |
| O8 | Cloudflare: the tunnel's hostnames, Cloudflare Access on staging and Grafana, the rate-limiting rule | Medium: staging or Grafana public | Stage B/C, with screenshots in MIGRATION_TEST_REPORT.md |
