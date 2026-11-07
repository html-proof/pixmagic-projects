# Database migration report

How production's databases move from RDS to the iKorex server, how the copy is proved whole, and
each time it has run. **Status (2026-11-07):** the method is built and tested on the owner's PC
against PostgreSQL. It has not yet run against RDS or on the server: the stage B rehearsal waits
for SSH access, and the real copy is step 3 of the cutover (stage D).

## What moves

| What | Where on AWS | Size | Moves how |
| --- | --- | --- | --- |
| `app`: every customer record (stores, orders, sales, inventory, ads, SMS, staff, sessions…) | RDS PostgreSQL 17.11 | 1.8 GB used (CloudWatch, 2026-11-06); 155 tables, 149 of them under row-level security, 293 policies, 65 migrations | This copy |
| `evolution`: the WhatsApp service's instances and their WhatsApp sessions | Same RDS instance, its own role | Small | This copy, restored as its own role so the service still owns its tables |
| Database roles and their passwords | RDS | n/a | **Not copied.** On the server the roles come from `init.sql` (through `admin migrate`) with the server's own passwords (`env/owner.env`); no password leaves AWS, and none travels in a dump |
| User passwords | Cognito | n/a | Not moved: Cognito stays (decision 2) |
| The coordinator's items (rate limits, locks) | DynamoDB `coord` | Small, short-lived | Cutover step 4: `admin import-coord` |
| Queued jobs | SQS | Drained to empty before the copy (cutover step 2; the copy refuses otherwise) | Not moved |
| SMS delivery events | SQS `smsEvents` | Waits there | Read by the server once it is live (`sqsBridge.ts`) |

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
  server on stdin (never on a command line, which other users of a host can read) → the postgres
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
the queues are drained, stops web, worker and evolution on the server (not live yet: DNS still
points at AWS), replaces the server's `app` and `evolution`, runs `admin migrate`, and compares
again (the migrations' ledger may only grow).

## Tested

### 2026-11-07, the owner's PC (PostgreSQL 18.6, Windows 11, Git Bash)

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

To record: the dump's size and time per database, download and restore time, the comparison
(expected: every table equal), the disk used during the restore, and the WAL archived meanwhile.

### Stage D cutover copy: not yet run

To record: the same, plus the queues' state before, the `migrate` output and the comparison after
it, and the time from freeze to the copy checked (the window's longest step).

## Open before stage D

- **The reverse copy for the rollback period** (ROLLBACK_PLAN.md: iKorex back to RDS). `copy-db.sh`
  works in either direction (dump on the server, restore through the admin host), but
  `copy-db.mjs` only drives this one; the reverse driver and its timed test come before the cutover.
- RDS's extensions are not known from here; the rehearsal shows any the server's image lacks
  (the restore then fails whole, in its one transaction).
