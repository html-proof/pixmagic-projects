#!/bin/bash
# deploy.sh <tag>: on the iKorex server, in the Compose project's folder (~/bizinsights or
# ~/bizinsights-staging). The image bizinsights:<tag> must be there already (ship.sh builds it).
#
#   1. the migrations, in a one-off admin container, before anything switches (as Deploy to AWS's
#      migrate-before-live gate): if they fail, the running release is untouched
#   2. web and worker recreated on the new image
#   3. both healthy within 3 minutes, /api/readyz ok and /api/version naming this commit
#   4. any failure in 2-3: the previous tag comes back, and the script exits 1
#   5. images of all but the newest three releases removed, and releases/ trimmed alike
set -euo pipefail
cd "$(dirname "$0")/.."
tag="${1:?usage: deploy.sh <tag>}"
project="$(basename "$PWD")"
log() { echo "$(date -u +%FT%TZ) deploy $project $tag: $*"; }
compose() { docker compose -p "$project" "$@"; }

for f in env/app.env env/owner.env env/postgres.env env/evolution.env env/cloudflared.env; do
  [ -f "$f" ] || { log "missing $f (env/*.example says what goes in it)"; exit 1; }
done
[ -f .env ] || printf 'APP_TAG=\nSCHEDULES=off\n' > .env
docker image inspect "bizinsights:$tag" >/dev/null
previous="$(sed -n 's/^APP_TAG=//p' .env)"
set_tag() { sed -i "s/^APP_TAG=.*/APP_TAG=$1/" .env; }

# The database first (it must be up for the migrations), then the WhatsApp service's own database.
compose up -d --build postgres
log "migrations"
APP_TAG="$tag" compose --profile admin run --rm -T admin migrate
APP_TAG="$tag" compose --profile admin run --rm -T admin evolution-db >/dev/null

# The read-only monitoring login, if the monitoring settings are there (idempotent).
if [ -f env/postgres-exporter.env ]; then
  pw="$(sed -n 's/^MONITOR_DB_PASSWORD=//p' env/postgres-exporter.env)"
  if [ -n "$pw" ]; then
    # The password goes in on stdin, not the command line (which every process on the host can read).
    {
      printf "\\set pw '%s'\n" "$pw"
      cat <<'SQL'
SELECT format('CREATE ROLE monitor LOGIN IN ROLE pg_monitor PASSWORD %L', :'pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitor') \gexec
SELECT format('ALTER ROLE monitor PASSWORD %L', :'pw') \gexec
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SQL
    } | compose exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U app -d app >/dev/null
  fi
fi

healthy() {
  local id state
  for svc in web worker; do
    id="$(compose ps -q "$svc")"
    [ -n "$id" ] || return 1
    state="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo none)"
    [ "$state" = "healthy" ] || return 1
  done
}
check() {
  local until=$((SECONDS + 180))
  until healthy; do
    [ $SECONDS -lt $until ] || { log "not healthy within 3 minutes"; return 1; }
    sleep 5
  done
  compose exec -T web node -e "
    const get = (p) => fetch('http://127.0.0.1:8080' + p).then(async (r) => ({ ok: r.ok, body: await r.json() }));
    Promise.all([get('/api/readyz'), get('/api/version')]).then(([ready, version]) => {
      if (!ready.ok) { console.error('readyz', JSON.stringify(ready.body)); process.exit(1); }
      if (!String(version.body.commit || '').startsWith(process.argv[1])) { console.error('version', JSON.stringify(version.body)); process.exit(1); }
    }, (e) => { console.error(String(e)); process.exit(1); });" "$tag"
}

log "switching from ${previous:-nothing}"
set_tag "$tag"
compose up -d --remove-orphans web worker evolution backup cloudflared
if ! check; then
  if [ -n "$previous" ] && [ "$previous" != "$tag" ]; then
    log "FAILED: back to $previous"
    set_tag "$previous"
    compose up -d web worker
    check || log "the previous release isn't healthy either: look at 'docker compose -p $project logs web worker'"
  else
    log "FAILED, and there is no previous release to go back to"
  fi
  exit 1
fi
log "live"

# Keep the newest three releases (images and bundles).
keep="$(ls -1t releases 2>/dev/null | head -3)"
for r in $(ls -1 releases 2>/dev/null); do
  echo "$keep" | grep -qx "$r" && continue
  [ "$r" = "$tag" ] || [ "$r" = "$previous" ] && continue
  rm -rf "releases/$r"
  docker image rm "bizinsights:$r" >/dev/null 2>&1 || true
done
