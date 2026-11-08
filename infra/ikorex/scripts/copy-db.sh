#!/bin/bash
# copy-db.sh dump | restore | facts: the database copy between RDS and the iKorex server
# (docs/ikorex-migration/DATABASE_MIGRATION_REPORT.md). Two drivers run it in both places, AWS's admin
# host (through Systems Manager: the database has no public address) and the server's postgres
# container (over SSH): copy-db.mjs from RDS to the server (dump on AWS, restore on the server), and
# copy-db-back.mjs back again for a rollback (dump on the server, restore on AWS). Settings come from
# the environment, never the command line (which every process on a host can read); the connection
# from libpq's variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGSSLMODE).
#
#   DBS="app evolution"            the databases, by key
#   dump:    DB_<key>              the source database (default: the key)
#            DEST_<key>            s3://bucket/key (the AWS CLI, the bucket's own encryption), https://…
#                                  (a presigned upload link: from the server) or a file
#   restore: SOURCE_<key>          https://… (a presigned URL), s3://bucket/key (the AWS CLI with this
#                                  host's own role: the admin host) or a file
#            SHA_<key>             the dump's sha256 (dump's result): checked before anything changes
#            BYTES_<key>           the dump's size, for the disk checks
#            TARGET_<key>          the database to restore into
#            ROLE_<key>            the role to own what is restored (Evolution's tables are its own)
#            NEED_ROLES_<key>      roles the dump's row-level security policies name, made if missing
#            MODE=fresh            make each target (refused if it exists); DROP_AFTER=1 drops them
#                                  at the end (a rehearsal)
#            MODE=replace          each target exists and nothing else is connected to it: its
#                                  schema is emptied first (the cutover)
#            MODE=empty (default)  each target exists and has no tables
#            FREE_BYTES            the free space where the database lives, when this host can't
#                                  read it (RDS: CloudWatch's FreeStorageSpace, given by the driver)
#   facts:   TARGET_<key>          what restore checks, read again (after the migrations, at cutover)
#
# For each database, `dump` exports the snapshot of a read-only repeatable-read transaction, reads
# the row count of every table, the row-level security flags and the policies inside it, and has
# pg_dump dump that same snapshot. So the counts are exactly what the dump holds, even while the
# source keeps taking writes (a rehearsal while production is live), and `restore` is checked
# against them table by table. Every target is checked before anything is fetched or changed, so a
# refusal leaves every database as it was. Progress goes to stderr; stdout gets one line,
# `COPY-RESULT <json>`. Nothing from the data itself is printed, and no link.
set -euo pipefail

log() { echo "$(date -u +%FT%TZ) copy-db: $*" >&2; }
die() { log "REFUSED: $*"; exit 1; }
var() { local name="$1_$2"; printf '%s' "${!name:-${3:-}}"; }
# psql on Windows (the tests) ends lines with CR LF.
q() { psql -X -q -A -t -v ON_ERROR_STOP=1 "$@" | tr -d '\r'; }
ident() { [[ "$1" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "\"$1\" is not a plain database or role name"; }
# curl with the link in a config on its stdin, never on its command line: any user of the host can
# read a process's arguments (ps, /proc/<pid>/cmdline), and a presigned link is the dump for an hour.
curl_link() {
  local link="$1" unsafe='[[:space:]"\\]'
  shift
  # Nothing that could end the config's quoted value: a presigned link has none.
  [[ "$link" == https://* && ! "$link" =~ $unsafe ]] || die "not a plain https link"
  curl -fsS --retry 3 --retry-delay 5 "$@" -K - <<<"url = \"$link\""
}
# One JSON object: every table's exact row count, the tables with row-level security, the policies.
facts_sql() {
  cat <<'SQL'
SELECT jsonb_build_object(
  'counts', (SELECT coalesce(json_object_agg(k, c ORDER BY k), '{}') FROM (
      SELECT format('%s.%s', schemaname, tablename) AS k,
             (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint AS c
      FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg\_%') t),
  'rls', (SELECT coalesce(json_agg(r ORDER BY r), '[]') FROM (
      SELECT format('%s.%s%s', n.nspname, c.relname, CASE WHEN c.relforcerowsecurity THEN ' (forced)' ELSE '' END) AS r
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity) t),
  'policies', (SELECT count(*) FROM pg_policies),
  'policies_md5', (SELECT md5(coalesce(string_agg(concat_ws('|', schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check), E'\n'
      ORDER BY schemaname, tablename, policyname), '')) FROM pg_policies)
)::text;
SQL
}
# The size of a file in bytes, and its sha256 (GNU coreutils on every host this runs on).
bytes() { wc -c <"$1" | tr -d ' '; }
sha() { sha256sum "$1" | cut -d' ' -f1; }

dump() {
  local tmp out="" key db dest snap facts t0 file
  tmp="$(mktemp -d "${TMPDIR_COPY:-/var/tmp}/copy-db.XXXXXX")"
  trap "rm -rf '$tmp'" EXIT
  for key in $DBS; do
    db="$(var DB "$key" "$key")"; dest="$(var DEST "$key")"
    [ -n "$dest" ] || die "DEST_$key is not set"
    t0=$SECONDS
    log "$key: snapshot of $db"
    # The transaction stays open until pg_dump is done with its snapshot.
    # psql itself, not q: tr would hold its answers back in a buffer.
    coproc SNAP { psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$db" 2>&1; }
    local pid=$SNAP_PID
    printf '%s\n' "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" "SELECT pg_export_snapshot();" >&"${SNAP[1]}"
    read -r snap <&"${SNAP[0]}" || die "$key: no answer from $db"
    snap="${snap%$'\r'}"
    [[ "$snap" =~ ^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$ ]] || die "$key: could not export a snapshot ($snap)"
    facts_sql >&"${SNAP[1]}"
    read -r facts <&"${SNAP[0]}" || die "$key: no answer from $db"
    facts="${facts%$'\r'}"
    [ "${facts:0:1}" = "{" ] || die "$key: could not read the counts ($facts)"
    log "$key: dumping"
    file="$tmp/$key.dump"
    pg_dump --snapshot="$snap" --format=custom --compress=1 --no-owner --no-privileges -d "$db" -f "$file"
    printf '%s\n' "COMMIT;" "\\q" >&"${SNAP[1]}"
    wait "$pid" 2>/dev/null || true
    local size digest
    size="$(bytes "$file")"; digest="$(sha "$file")"
    if [[ "$dest" == s3://* ]]; then
      log "$key: uploading $size bytes"
      aws s3 cp "$file" "$dest" --only-show-errors
    elif [[ "$dest" == https://* ]]; then
      log "$key: uploading $size bytes"
      curl_link "$dest" -T "$file" -o /dev/null
    else
      mv "$file" "$dest"
    fi
    rm -f "$file"
    out+="${out:+,}\"$key\":{\"db\":\"$db\",\"server\":\"$(q -d "$db" -c 'SHOW server_version')\",\"bytes\":$size,\"sha256\":\"$digest\",\"seconds\":$((SECONDS - t0)),\"facts\":$facts}"
    log "$key: done in $((SECONDS - t0)) s"
  done
  echo "COPY-RESULT {$out}"
}

preflight() {
  # WAL that can't be archived stays on the server's disk: a restore writes about as much WAL as data.
  local tmpdir="$1" failing free need=0 dumps=0 key size dir
  failing="$(q -d postgres -c "SELECT current_setting('archive_mode') <> 'off' AND coalesce(last_failed_time > coalesce(last_archived_time, 'epoch'), false) FROM pg_stat_archiver")"
  [ "$failing" = "f" ] || die "WAL archiving is failing (pg_stat_archiver): the restore's WAL would pile up on the server's disk. Fix the backups first."
  for key in $DBS; do
    size="$(var BYTES "$key" 0)"; dumps=$((dumps + size)); need=$((need + size * 4))
  done
  # The dumps are downloaded here first (on the admin host, /var/tmp: its /tmp is held in memory).
  if free="$(df -Pk "$tmpdir" 2>/dev/null | awk 'NR == 2 { print $4 * 1024 }')" && [ -n "$free" ]; then
    [ "$free" -ge "$dumps" ] || die "$free bytes free in $tmpdir; the dumps are $dumps"
  fi
  dir="$(q -d postgres -c 'SHOW data_directory' 2>/dev/null || true)"
  if [ -n "${FREE_BYTES:-}" ]; then
    [[ "$FREE_BYTES" =~ ^[0-9]+$ ]] || die "FREE_BYTES is not a number of bytes"
    [ "$FREE_BYTES" -ge "$need" ] || die "$FREE_BYTES bytes free where the database lives; the restore wants about $need (4 times the dumps)"
    log "disk: $FREE_BYTES bytes free (given), about $need needed"
  elif [ -n "$dir" ] && free="$(df -Pk "$dir" 2>/dev/null | awk 'NR == 2 { print $4 * 1024 }')" && [ -n "$free" ]; then
    [ "$free" -ge "$need" ] || die "$free bytes free where the database lives; the restore wants about $need (4 times the dumps)"
    log "disk: $free bytes free, about $need needed"
  else
    log "disk: could not read the free space; carrying on"
  fi
}

# What MODE needs of one target. Checked for every target before anything is fetched or changed,
# and again just before each one changes.
check_target() {
  local key="$1" target="$2" mode="$3" exists others tables
  exists="$(q -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = '$target'")"
  if [ "$mode" = "fresh" ]; then
    [ "$exists" = "0" ] || die "$key: $target already exists (MODE=fresh makes it; drop it or pick another name)"
    return 0
  fi
  [ "$exists" = "1" ] || die "$key: $target does not exist"
  # The exporter's read-only `monitor` login reads statistics only and holds no table: it may stay.
  others="$(q -d postgres -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$target' AND pid <> pg_backend_pid() AND usename IS DISTINCT FROM 'monitor'")"
  [ "$others" = "0" ] || die "$key: $others other connection(s) to $target: stop what uses it first (on the server: docker compose stop web worker evolution)"
  tables="$(q -d "$target" -c "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg\_%'")"
  if [ "$tables" != "0" ]; then
    [ "$mode" = "replace" ] || die "$key: $target has $tables tables (MODE=replace empties it)"
    [ "$(q -d "$target" -c "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'public') AND schemaname NOT LIKE 'pg\_%'")" = "0" ] \
      || die "$key: $target has tables outside the public schema: not emptying it by hand-made rules"
  fi
  return 0
}

restore() {
  local tmp out="" key src want target role file got t0 tables r
  local mode="${MODE:-empty}"
  [[ "$mode" =~ ^(fresh|replace|empty)$ ]] || die "MODE must be fresh, replace or empty"
  tmp="$(mktemp -d "${TMPDIR_COPY:-/tmp}/copy-db.XXXXXX")"
  trap "rm -rf '$tmp'" EXIT
  preflight "$tmp"
  # Every target first: a refusal for the second database leaves the first as it was too.
  for key in $DBS; do
    target="$(var TARGET "$key")"; role="$(var ROLE "$key")"
    [ -n "$(var SOURCE "$key")" ] && [ -n "$(var SHA "$key")" ] && [ -n "$target" ] || die "SOURCE_$key, SHA_$key and TARGET_$key must be set"
    ident "$target"
    [ -z "$role" ] || ident "$role"
    for r in $(var NEED_ROLES "$key"); do ident "$r"; done
    check_target "$key" "$target" "$mode"
  done
  # Fetch and check every dump before any database changes.
  for key in $DBS; do
    src="$(var SOURCE "$key")"; want="$(var SHA "$key")"
    file="$tmp/$key.dump"
    if [[ "$src" == https://* ]]; then
      log "$key: downloading"
      curl_link "$src" -o "$file"
    elif [[ "$src" == s3://* ]]; then
      log "$key: downloading"
      aws s3 cp "$src" "$file" --only-show-errors
    else
      cp "$src" "$file"
    fi
    got="$(sha "$file")"
    [ "$got" = "$want" ] || die "$key: the dump's sha256 is $got, not $want: not restoring anything"
  done
  for key in $DBS; do
    target="$(var TARGET "$key")"; role="$(var ROLE "$key")"; file="$tmp/$key.dump"; t0=$SECONDS
    for r in $(var NEED_ROLES "$key"); do
      # LOGIN without a password: the migrate action gives each its own (apps/aws/src/migrate.ts).
      q -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname = '$r'" | grep -q 1 \
        || { log "$key: making role $r"; q -d postgres -c "CREATE ROLE \"$r\" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION"; }
    done
    check_target "$key" "$target" "$mode"
    if [ "$mode" = "fresh" ]; then
      log "$key: creating $target"
      q -d postgres -c "CREATE DATABASE \"$target\" TEMPLATE template0 ENCODING 'UTF8'${role:+ OWNER \"$role\"}"
    else
      tables="$(q -d "$target" -c "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg\_%'")"
      if [ "$tables" != "0" ]; then
        log "$key: emptying $target ($tables tables)"
        q -d "$target" -c "DROP SCHEMA public CASCADE" -c "CREATE SCHEMA public${role:+ AUTHORIZATION \"$role\"}"
      fi
    fi
    log "$key: restoring into $target"
    # One transaction: a failure leaves the target as it was. --clean --if-exists: the source's
    # public schema may have been made again (it was on RDS, in the move to AWS), and the dump then
    # carries a CREATE SCHEMA public that only an empty target with its schema dropped first takes.
    pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --clean --if-exists ${role:+--role="$role"} -d "$target" "$file"
    q -d "$target" -c "ANALYZE"
    out+="${out:+,}\"$key\":{\"db\":\"$target\",\"sha256\":\"$(sha "$file")\",\"seconds\":$((SECONDS - t0)),\"facts\":$(facts_sql | q -d "$target")}"
    log "$key: restored in $((SECONDS - t0)) s"
    rm -f "$file"
  done
  if [ "$mode" = "fresh" ] && [ "${DROP_AFTER:-0}" = "1" ]; then
    for key in $DBS; do
      target="$(var TARGET "$key")"
      log "dropping $target (rehearsal)"
      q -d postgres -c "DROP DATABASE \"$target\" WITH (FORCE)"
    done
  fi
  echo "COPY-RESULT {$out}"
}

facts() {
  local out="" key target
  for key in $DBS; do
    target="$(var TARGET "$key")"; ident "$target"
    out+="${out:+,}\"$key\":{\"db\":\"$target\",\"facts\":$(facts_sql | q -d "$target")}"
  done
  echo "COPY-RESULT {$out}"
}

main() {
  # Nothing below reads stdin: with `bash -s` the script itself arrives on it.
  exec </dev/null
  [ -n "${DBS:-}" ] || die "DBS is not set"
  case "${1:-}" in
    dump | restore | facts) "$1" ;;
    *) die "usage: copy-db.sh dump|restore|facts (settings: the comment at the top)" ;;
  esac
}

main "$@"
