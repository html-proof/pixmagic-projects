#!/bin/bash
# The `backup` service (infra/ikorex/docker-compose.yml): the PostgreSQL image again, sharing the
# database's data volume and socket, running as `postgres`. It sets pgBackRest up once, then every
# night at BACKUP_HOUR_UTC (default 02) takes a backup: full on Sundays, differential otherwise.
# Old backups expire by pgbackrest.conf's retention. On Sundays the restore test follows
# (restore-test.sh). Each night ends with a ping to BACKUP_PING_URL (an external check such as
# healthchecks.io), "/fail" appended when something failed: no ping for a day is the alarm.
set -uo pipefail
STANZA=bizinsights
HOUR="${BACKUP_HOUR_UTC:-02}"
log() { echo "$(date -u +%FT%TZ) backup: $*"; }
ping() {
  [ -n "${BACKUP_PING_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 "${BACKUP_PING_URL}$1" -o /dev/null || log "ping failed"
}

until pg_isready -h /var/run/postgresql -U app -q; do sleep 5; done

# Once: the stanza (pgBackRest's name for this cluster in the bucket). Repeating it is harmless.
if ! pgbackrest --stanza="$STANZA" stanza-create; then
  log "stanza-create failed: check the bucket settings (PGBACKREST_REPO1_*)"
  ping "/fail"
fi
if ! pgbackrest --stanza="$STANZA" check; then
  log "archiving check failed: WAL is not reaching the bucket"
  ping "/fail"
fi
# No backup yet (a new server, or a new bucket): a full one now, not tonight.
if ! pgbackrest --stanza="$STANZA" info --output=json | grep -q '"label"'; then
  log "no backup in the bucket yet: taking a full one now"
  pgbackrest --stanza="$STANZA" --type=full backup && ping "" || ping "/fail"
fi

while true; do
  now=$(date -u +%s)
  next=$(date -u -d "today ${HOUR}:30" +%s)
  [ "$next" -le "$now" ] && next=$(date -u -d "tomorrow ${HOUR}:30" +%s)
  sleep $((next - now))

  type=diff
  [ "$(date -u +%u)" = "7" ] && type=full
  log "starting a $type backup"
  ok=1
  pgbackrest --stanza="$STANZA" --type="$type" backup || ok=0
  pgbackrest --stanza="$STANZA" check || ok=0
  if [ "$type" = "full" ] && [ "$ok" = "1" ]; then
    /usr/local/bin/restore-test.sh || ok=0
  fi
  if [ "$ok" = "1" ]; then log "done"; ping ""; else log "FAILED"; ping "/fail"; fi
done
