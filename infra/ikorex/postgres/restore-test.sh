#!/bin/bash
# The weekly restore test (backup-loop.sh runs it after Sunday's full backup; by hand:
# `docker compose exec backup restore-test.sh`). It restores the newest backup from the bucket into a
# scratch folder, starts it as a second PostgreSQL on a private socket (no TCP), and compares it with
# the live database: the same tables, the same applied migrations, and no less than 90 % of the
# live row count (the live database keeps changing after the backup). It prints both counts, then
# stops and deletes the copy. Exit 0 = the backup restores.
set -euo pipefail
STANZA=bizinsights
DIR="${RESTORE_TEST_DIR:-/restore-test}"
SOCK=/tmp/restore-test-sock
PORT=5499
log() { echo "$(date -u +%FT%TZ) restore-test: $*"; }

cleanup() {
  pg_ctl -D "$DIR/data" -m fast -w stop >/dev/null 2>&1 || true
  rm -rf "$DIR/data" "$SOCK"
}
trap cleanup EXIT
cleanup
mkdir -p "$DIR/data" "$SOCK"
chmod 700 "$DIR/data"

log "restoring the newest backup"
pgbackrest --stanza="$STANZA" --pg1-path="$DIR/data" --type=immediate --target-action=promote --archive-mode=off --delta restore
pg_ctl -D "$DIR/data" -w -t 600 -l "$DIR/restore.log" \
  -o "-p $PORT -c listen_addresses='' -c unix_socket_directories=$SOCK -c archive_mode=off -c shared_preload_libraries='' -c shared_buffers=128MB" start

MIG_SQL="SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL"
q() { psql -X -At -h "$1" -p "$2" -U app -d app -c "$3"; }

# Exact counts on both sides (statistics are empty right after a restore, and the database is small).
exact_total() {
  psql -X -At -h "$1" -p "$2" -U app -d app <<'SQL'
DO $$ DECLARE t text; n bigint; total bigint := 0; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n; total := total + n;
  END LOOP;
  RAISE NOTICE 'total=%', total;
END $$;
SQL
}

live_tables=$(q /var/run/postgresql 5432 "SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public'")
copy_tables=$(q "$SOCK" "$PORT" "SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public'")
live_mig=$(q /var/run/postgresql 5432 "$MIG_SQL")
copy_mig=$(q "$SOCK" "$PORT" "$MIG_SQL")
live_total=$(exact_total /var/run/postgresql 5432 2>&1 | sed -n 's/.*total=\([0-9]*\).*/\1/p')
copy_total=$(exact_total "$SOCK" "$PORT" 2>&1 | sed -n 's/.*total=\([0-9]*\).*/\1/p')
log "live: $live_total rows, $live_mig migrations; restored copy: $copy_total rows, $copy_mig migrations"

fail=0
[ "$live_tables" = "$copy_tables" ] || { log "FAIL: the tables differ"; fail=1; }
[ "$live_mig" = "$copy_mig" ] || { log "FAIL: the applied migrations differ"; fail=1; }
if [ -z "$copy_total" ] || [ -z "$live_total" ] || [ $((copy_total * 10)) -lt $((live_total * 9)) ]; then
  log "FAIL: the copy has under 90 % of the live rows"
  fail=1
fi
[ "$fail" = "0" ] && log "PASS" || log "FAILED"
exit "$fail"
