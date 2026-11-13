#!/bin/bash
# The `backup` service (infra/ikorex/docker-compose.yml): the PostgreSQL image again, sharing the
# database's data volume and socket, running as `postgres`. It sets pgBackRest up once, then every
# night at BACKUP_HOUR_UTC (default 02) takes a backup: full on Sundays, differential otherwise.
# Old backups expire by each repository's retention. On Sundays the restore test follows
# (restore-test.sh). Each night ends with a ping to BACKUP_PING_URL (an external check such as
# healthchecks.io), "/fail" appended when something failed: no ping for a day is the alarm.
#
# Repositories: repo1 is the bucket off the server (pgbackrest.conf, env/postgres.env). repo2, when
# PGBACKREST_REPO2_PATH is set, is a second copy on this server's own disk (the volume `pgbackups`):
# quick to restore from and there when the bucket's provider isn't, but lost with the server, so it
# is never the only one. The write-ahead log goes to every repository by itself (archive-push); a
# backup goes to one repository per run, so each night runs once per repository.
set -uo pipefail
STANZA=bizinsights
HOUR="${BACKUP_HOUR_UTC:-02}"
REPOS="1"
[ -n "${PGBACKREST_REPO2_PATH:-}" ] && REPOS="1 2"
log() { echo "$(date -u +%FT%TZ) backup: $*"; }
ping() {
  [ -n "${BACKUP_PING_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 "${BACKUP_PING_URL}$1" -o /dev/null || log "ping failed"
}
# backup_all <type>: one backup in every repository; fails if any did.
backup_all() {
  local type="$1" failed=0 repo
  for repo in $REPOS; do
    pgbackrest --stanza="$STANZA" --repo="$repo" --type="$type" backup || { log "repo$repo: the $type backup failed"; failed=1; }
  done
  return "$failed"
}

until pg_isready -h /var/run/postgresql -U app -q; do sleep 5; done
log "repositories: $REPOS"

# Once: the stanza (pgBackRest's name for this cluster) in every repository. Repeating it is harmless.
if ! pgbackrest --stanza="$STANZA" stanza-create; then
  log "stanza-create failed: check the repositories' settings (PGBACKREST_REPO1_*, PGBACKREST_REPO2_*)"
  ping "/fail"
fi
if ! pgbackrest --stanza="$STANZA" check; then
  log "archiving check failed: WAL is not reaching every repository"
  ping "/fail"
fi
# A repository with no backup yet (a new server, a new bucket, the local copy just added): a full
# one now, not tonight.
first=0
for repo in $REPOS; do
  if ! pgbackrest --stanza="$STANZA" --repo="$repo" info --output=json | grep -q '"label"'; then
    log "repo$repo: no backup yet: taking a full one now"
    pgbackrest --stanza="$STANZA" --repo="$repo" --type=full backup || first=2
    [ "$first" = 2 ] || first=1
  fi
done
[ "$first" = 1 ] && ping ""
[ "$first" = 2 ] && ping "/fail"

while true; do
  now=$(date -u +%s)
  next=$(date -u -d "today ${HOUR}:30" +%s)
  [ "$next" -le "$now" ] && next=$(date -u -d "tomorrow ${HOUR}:30" +%s)
  sleep $((next - now))

  type=diff
  [ "$(date -u +%u)" = "7" ] && type=full
  log "starting a $type backup (repositories: $REPOS)"
  ok=1
  backup_all "$type" || ok=0
  pgbackrest --stanza="$STANZA" check || ok=0
  if [ "$type" = "full" ] && [ "$ok" = "1" ]; then
    /usr/local/bin/restore-test.sh || ok=0
  fi
  if [ "$ok" = "1" ]; then log "done"; ping ""; else log "FAILED"; ping "/fail"; fi
done
