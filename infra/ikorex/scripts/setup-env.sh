#!/bin/bash
# setup-env.sh <project> <app url>: the first-time settings of a bizinsights project folder on the
# iKorex server (~/bizinsights or ~/bizinsights-staging). Run once the release's files are there
# (env/*.example). The app's secrets come from files env/app.env.from-aws and env/evolution.env.from-aws
# beside them, if there are any (the move from AWS wrote them; a new copy of the server takes them from
# the running project's env/app.env and env/evolution.env under those names):
#
#   ssh deployer@103.146.112.176 'bash -s -- bizinsights-staging https://staging.bizinsights.io' < infra/ikorex/scripts/setup-env.sh
#
# It makes each env/*.env from its example, gives every database login a new password (the same
# value wherever its placeholder stands), merges AWS's values into app.env and evolution.env (all but
# APP_URL and API_URL, which are this copy's own), deletes the .from-aws files, and writes .env with
# the low-memory limits (docker-compose.lean.yml) and no write-ahead log archive until a backup
# bucket is set. It prints names and counts only, never a value. Safe to run again: it keeps what is
# already set. Left for the owner: env/cloudflared.env (the tunnel's token) and the backup bucket in
# env/postgres.env.
set -euo pipefail
project="${1:?project}"
url="${2:?app url}"
[[ "$project" =~ ^bizinsights(-staging)?$ ]] || { echo "project must be bizinsights or bizinsights-staging" >&2; exit 2; }
[[ "$url" =~ ^https://[a-z0-9.-]+$ ]] || { echo "the app url must be https://host" >&2; exit 2; }
cd "$HOME/$project"
chmod 750 .
umask 077
mkdir -p env
chmod 700 env

# What Compose itself reads: the low-memory limits, no write-ahead log kept until a backup bucket is set.
if [ ! -f .env ]; then
  printf 'APP_TAG=\nSCHEDULES=off\nCOMPOSE_FILE=docker-compose.yml:docker-compose.lean.yml\nARCHIVE_MODE=off\n' > .env
  echo "wrote .env (lean limits, schedules off, archive off)"
fi
chmod 644 .env

cd env
for f in app owner postgres evolution cloudflared; do
  # (No carriage return may reach an env file: Docker would read it as part of the value.)
  [ -f "$f.env" ] || tr -d '\r' < "$f.env.example" > "$f.env"
done

# A new password for each database login, the same value wherever its placeholder stands.
gen() { openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | cut -c1-40; }
for name in POSTGRES_PASSWORD SYSTEM_DB_PASSWORD APP_RLS_PASSWORD EVOLUTION_DB_PASSWORD; do
  if grep -q "CHANGE_ME_$name" app.env owner.env postgres.env evolution.env; then
    v="$(gen)"
    [ "${#v}" -eq 40 ] || { echo "could not generate a password" >&2; exit 1; }
    sed -i "s/CHANGE_ME_$name/$v/g" app.env owner.env postgres.env evolution.env
    echo "generated $name"
  fi
done

# set_line <file> <KEY> <whole line>: replace KEY's line, or add it. Values may hold any character,
# so they travel in the environment, not through sed or awk's own escapes.
set_line() {
  local file="$1"
  if grep -q "^$2=" "$file"; then
    KEY="$2" LINE="$3" awk 'index($0, ENVIRON["KEY"] "=") == 1 { print ENVIRON["LINE"]; next } { print }' "$file" > "$file.tmp"
    cat "$file.tmp" > "$file"
    rm -f "$file.tmp"
  else
    printf '%s\n' "$3" >> "$file"
  fi
}
# merge <from> <into> [keys to leave out...]
merge() {
  local from="$1" into="$2" line key skip n=0
  shift 2
  [ -f "$from" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    key="${line%%=*}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
    skip=0
    for s in "$@"; do [ "$key" = "$s" ] && skip=1; done
    [ "$skip" = 1 ] && continue
    set_line "$into" "$key" "$line"
    n=$((n + 1))
  done < "$from"
  rm -f "$from"
  echo "merged $n settings from AWS into $into"
}
merge app.env.from-aws app.env APP_URL API_URL
merge evolution.env.from-aws evolution.env
set_line app.env APP_URL "APP_URL=$url"
chmod 600 ./*.env

echo "--- $project/env"
ls -l ./*.env | awk '{ print $1, $5, $9 }'
if grep -l 'CHANGE_ME' ./*.env; then echo "placeholders left in the files above" >&2; exit 1; fi
echo "settings left empty (names only):"
for f in app evolution postgres cloudflared; do
  empty="$(grep -E '^[A-Z][A-Z0-9_]*=$' "$f.env" | tr -d '=' | tr '\n' ' ' || true)"
  echo "  $f.env: ${empty:-none}"
done
