# Database migration report

How production's databases move from RDS to the iKorex server, how the copy is proved whole, and
each time it has run. **Status (2026-11-08):** the method is built and tested on the owner's PC
against PostgreSQL in both directions: to the server (`copy-db.mjs`, 2026-11-07) and back to RDS
for a rollback (`copy-db-back.mjs`, 2026-11-08, [below](#the-way-back-copy-db-backmjs)). Neither
has yet run against RDS or on the server: the stage B rehearsal of both waits for SSH access, and
the real copy is step 3 of the cutover (stage D).

## What moves

| What | Where on AWS | Size | Moves how |
| --- | --- | --- | --- |
| `app`: every customer record (stores, orders, sales, inventory, ads, SMS, staff, sessions…) | RDS PostgreSQL 17.11 | 1.8 GB used (CloudWatch, 2026-11-06); 155 tables, 149 of them under row-level security, 293 policies, 65 migrations | This copy |
| `evolution`: the WhatsApp service's instances and their WhatsApp sessions | Same RDS instance, its own role | Small | This copy, restored as its own role so the service still owns its tables |
| Database roles and their passwords | RDS | n/a | **Not copied.** On the server the roles come from `init.sql` (through `admin migrate`) with the server's own passwords (`env/owner.env`); no password leaves AWS, and none travels in a dump |
| User passwords | Cognito, and the app's own `auth_accounts` | n/a | Those who moved over to the app's own sign-in (`AUTH_MODE=migrating`): argon2id hashes in `auth_accounts`, part of this copy. The rest stay at Cognito, which still checks them until stage F (decision 2) |
| The coordinator's items (rate limits, locks) | DynamoDB `coord` | Small, short-lived | Cutover step 4: `admin import-coord` |
| Queued jobs | SQS | Drained to empty before the copy (cutover step 2; the copy refuses otherwise) | Not moved |
| SMS delivery events | Twilio's webhooks; SQS `smsEvents` only while SMS is on AWS | Twilio's arrive wherever `bizinsights.io` points; AWS's wait in SQS | Twilio's: nothing to move. AWS's: read by the server once it is live (`sqsBridge.ts`) |

## How: `infra/ikorex/scripts/copy-db.mjs` and `copy-db.sh`

```text
owner's PC (aws login, SSH key)
  │ 1. checks: pinned host key, server postgres healthy, (cutover) AWS queues empty
  │ 2. Systems Manager ──► AWS admin host (inside the VPC; RDS has no public address)
  │                          copy-db.sh dump: per database, one snapshot:
  │                          counts + RLS + policies read in it, pg_dump of it
  │                          ──► S3 artifacts bucket, db-export/<time>/ (encrypted, TLS only)
  │                          host stopped again
  │ 3. SSH ──► server: docker compose exec postgres bash -s  (settings and links on stdin)
  │                          copy-db.sh restore: download (links valid 1 h), sha256 checked,
  │                          pg_restore in one transaction, ANALYZE, the same counts read
  │ 4. compare table by table; (cutover) admin migrate, counts again
  │ 6. delete every version under db-export/<time>/; report (counts only) in ~/insights-backups
```

- **Exact even while production runs.** Each database's counts, row-level security flags and
  policies are read inside a read-only repeatable-read transaction whose snapshot `pg_dump` then
  dumps (`--snapshot`). The counts are what the dump holds, to the row, so a rehearsal can be
  checked exactly while customers keep writing.
- **Nothing half-done.** Every dump's sha256 is checked before any database changes; each restore
  is one transaction (`--single-transaction --exit-on-error`), so a failure leaves the target as it
  was.
- **The right owners.** `--no-owner --no-privileges`: the app's tables belong to the server's
  owner login and `init.sql` gives the tenant and system roles their grants again; Evolution's are
  restored as `evolution` (`--role`), so the service can still migrate them. Roles the policies
  name (`app_rls`, `app_system`) are made first if missing, with no password until `migrate`.
- **RDS's remade schema.** The move to AWS dropped and remade `public` on RDS, so its dump carries
  a `CREATE SCHEMA public`; `--clean --if-exists` restores that into an empty database.
- **Refusals before damage.** A target that exists (rehearsal), has tables (cutover without
  `--replace`), or has another connection (the exporter's read-only `monitor` login excepted) is
  refused; so is a restore while WAL archiving is failing (the WAL would pile up on the server's
  disk) or with less than four times the dumps' size free.
- **Where the data travels.** RDS → admin host (inside the VPC) → the artifacts bucket (S3-managed
  encryption, TLS required, public access blocked) → an HTTPS link valid for an hour, handed to the
  server on stdin (never on a command line, which other users of a host can read), and from there
  to `curl` in a config on its stdin, not in its arguments (until 2026-11-08 the link was on curl's
  command line, readable by any user of the server for the minute of the download) → the postgres
  container's `/tmp`, deleted after the restore. Unlike the move to AWS, the data never lands on
  the PC. The admin host may write under `db-export/` only; anything left there (the script failed
  before cleaning up) the bucket deletes after a day, and its old versions a day later.
- **What is printed and kept.** Table names, row counts, sizes, checksums and timings; never a row,
  a password or a link.

Rehearsal (stage B): `node infra/ikorex/scripts/copy-db.mjs --rehearsal` restores into throwaway
databases (`app_copy_test`, `evolution_copy_test`) of the staging project's PostgreSQL, compares,
and drops them. No app or WhatsApp service ever connects to them (two WhatsApp services on one
session would fight over it), and the AWS side only reads.

Cutover (stage D, step 3): `node infra/ikorex/scripts/copy-db.mjs --cutover --replace` checks that
the queues are drained and that AWS's WhatsApp service has no task (it would keep writing
`evolution` after the snapshot, and fight the server's service for every linked number), stops web,
worker and evolution on the server (not live yet: DNS still points at AWS), replaces the server's
`app` and `evolution`, runs `admin migrate`, and compares again (the migrations' ledger may only grow).

## The way back: `copy-db-back.mjs`

For a problem found after the server has taken writes (ROLLBACK_PLAN.md, "D/E, after writes on
iKorex"): the server's databases copied into RDS, proved whole the same way, so AWS takes over with
every write made on the server. The same `copy-db.sh` runs the other way round.

```text
owner's PC (aws login, SSH key)
  │ 1. checks: pinned host key, server postgres healthy, the source databases there, RDS available;
  │    rollback: the server's schedules off, AWS's WhatsApp service with no task,
  │    a manual RDS snapshot started (RDS as it was, kept until stage F)
  │ 2. rollback: SSH ──► server: web stopped; the worker drains the queue (≤ 10 min);
  │                       worker and evolution stopped (any failure after this starts them again)
  │ 3. SSH ──► server: docker compose exec postgres bash -s  (settings and two upload links on stdin)
  │                       copy-db.sh dump: per database, one snapshot, counts + RLS + policies in it,
  │                       pg_dump of it ──► S3 artifacts bucket, db-export/<time>-back/ (PUT links
  │                       signed on the PC for an hour, given to curl in a config on its stdin)
  │    the PC checks each object's size in the bucket
  │ 4. Systems Manager ──► AWS admin host: copy-db.sh restore from the bucket (the host's own
  │                       role reads it: no link in Systems Manager's command history), sha256
  │                       checked, RDS's free storage from CloudWatch for the disk check
  │    compare table by table; rollback: the cron function's migrate (init.sql's grants), counts again
  │ 5. delete every version under db-export/<time>-back/; report in ~/insights-backups
```

- **Rehearsal** (stage B, timed): `copy-db.mjs --rehearsal --keep` leaves its copy of production
  in the staging project (`app_copy_test`, `evolution_copy_test`); `copy-db-back.mjs --rehearsal`
  copies that back into throwaway databases of the same names on RDS, compares and drops them. A
  full-size round trip that touches neither copy's live databases; it runs on production's RDS
  instance, so outside the busy hours.
- **Rollback**: `copy-db-back.mjs --rollback --replace`, in a second short window. RDS's `app` and
  `evolution` are replaced (`MODE=replace`: refused while anything else is connected, every target
  checked before any changes); `evolution` restored as its role, which RDS's master is a member of.
  Then the steps it prints: DNS back to CloudFront, AWS's schedules and WhatsApp service on again,
  smoke tests.
- **Why the data never touches the PC**: the upload links are signed on the PC
  (`presignS3`, Signature Version 4, checked against AWS's documented example and against
  aws4fetch); only the links go to the server, where they reach `curl` on its stdin.
- **What it leaves behind**: on success, the server stopped (DNS is moved next) and a snapshot of
  RDS as it was before. On failure after the freeze, the server started again with its data
  untouched (only its schedules stay off, and the command to turn them on is printed); RDS, which
  nothing serves, as it was or as far as the copy got.

## Tested

### 2026-11-08, the owner's PC: the way back (PostgreSQL 18.6, Windows 11, Git Bash)

| Test | What it shows | Result |
| --- | --- | --- |
| `copyDb.test.ts`: dump to a presigned link | `copy-db.sh dump` uploads with `curl -T`, the link only in the config on curl's stdin: the recorded arguments hold no link, the stand-in bucket holds the dump with its size and sha256 | **Passed** (the real curl moves the file; only the bucket is a folder) |
| `copyDb.test.ts`: restore from a link and from `s3://` | The same dump restored from a presigned link and from `s3://` (the admin host's own role; an `aws` stand-in): the same facts both ways | **Equal** |
| `copyDb.test.ts`: as RDS's master | A login with no superuser and no `BYPASSRLS`, a member of the service's role (as `evolutionDb.ts` makes it): fresh, then replacing both databases; the service's tables stay its own | **Equal both times** |
| `copyDb.test.ts`: every target first | Replace with the second target busy: refused, the first neither emptied nor restored | **Refused, first unchanged** |
| `copyDb.test.ts`: `FREE_BYTES` | The free space RDS reports, too small: refused before any database exists; a value that isn't a number refused | **Refused** |
| `copyDb.test.ts`: a link that could break out of curl's config | Refused before anything runs | **Refused** |
| `copyDb.test.ts`, the seven tests of 2026-11-07 | Unchanged behaviour after the restructuring | **12 of 12 passed** in all |
| `copyDbPresign.test.ts` | An upload link (PUT, a session token) signed exactly as aws4fetch signs the same request | **Passed** |
| `copy-db-lib.test.mjs` (16 tests, 8 new) | The presigner gives AWS's documented example's signature; the admin host's script runs restore and facts with the dumps on its disk and refuses a link in its settings; the WhatsApp service found while a task runs, starts or is wanted; the queue counts; the snapshot's name; both drivers refuse a wrong command line, and a rollback without `--replace`, before touching AWS or the server | **16 passed** |
| `infra/cdk/test/stacks.test.ts` (2 new tests) | `-c whatsapp=off` sets AWS's WhatsApp service to no task and drops its two alarms; unset, empty or `on` changes nothing | **Passed** |

Not tested here, as for the way out: AWS (Systems Manager, the bucket, CloudWatch, the snapshot,
the cron function) and the server. The rehearsal runs both first.

### 2026-11-07, the owner's PC (PostgreSQL 18.6, Windows 11, Git Bash)

### 2026-11-07, the owner's PC: the way out (PostgreSQL 18.6, Windows 11, Git Bash)

Production will run 17.11 on both sides (RDS and the server's image); the rehearsal on the server
is the 17-to-17 run.

| Test | What it shows | Result |
| --- | --- | --- |
| `apps/aws/test/copyDb.test.ts`: dump | The real schema (all 65 migrations and `init.sql`, on a `public` schema remade as on RDS: 155 tables, 149 with row-level security, 293 policies) plus a database owned by its own role; inserts running the whole time | The snapshot held 3,037 rows in the table being written; the live table had 14,467 by the end, so the counts are the snapshot's, not the live ones |
| `copyDb.test.ts`: restore | Into new databases: every count, the row-level security list and the policies' checksum equal to the snapshot's; the second database's tables owned by its role; `facts` reads the same again | **Equal, table by table** |
| `copyDb.test.ts`: refusals | A wrong checksum refused before any database exists; a target with tables refused without replace; replace refused while another session is connected, the target left as it was; then replaced and equal | **All refused / equal** |
| `copyDb.test.ts`: rehearsal clean-up | The throwaway databases dropped at the end | **Dropped** |
| `infra/ikorex/scripts/copy-db-lib.test.mjs` (8 tests) | The pinned host key's fingerprint is the guide's; settings refused if they could break out of their quotes; the comparison fails on a missing, extra or different table, lost row-level security or a changed policy; after migrate only the ledger may grow; the admin host's script reads the login from its secret there and carries no password | **8 passed** |
| `infra/cdk/test/stacks.test.ts` (new test) | The admin host may put objects under `db-export/*` only; that prefix expires after one day, old versions one day later | **Passed (184 of 184)** |

Not tested here: the AWS side (Systems Manager, the bucket, presigned links) and the server side
(the container, `curl`, the disk check against a real volume). Both run first in the rehearsal.

### Stage B rehearsal: not yet run

To record, each way: the dump's size and time per database, upload, download and restore time,
the comparison (expected: every table equal), the disk used during the restore, and the WAL
archived meanwhile. The way back's total time is the rollback window's longest step.

### Stage D cutover copy: not yet run

To record: the same, plus the queues' state before, the `migrate` output and the comparison after
it, and the time from freeze to the copy checked (the window's longest step).

## Open before stage D

- **The way back, timed** (built 2026-11-08, [above](#the-way-back-copy-db-backmjs)): its first run
  is stage B's round trip, `copy-db.mjs --rehearsal --keep` then `copy-db-back.mjs --rehearsal`.
- RDS's extensions are not known from here; the rehearsal shows any the server's image lacks
  (the restore then fails whole, in its one transaction).
