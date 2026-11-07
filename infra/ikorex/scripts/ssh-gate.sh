#!/bin/bash
# ssh-gate.sh: all the deploy key may do on the iKorex server (Deploy to iKorex,
# .github/workflows/ikorex-deploy.yml). Installed once as ~/bin/bizinsights-ssh-gate, and named in
# the deploy key's line in ~/.ssh/authorized_keys:
#
#   restrict,command="$HOME/bin/bizinsights-ssh-gate" ssh-ed25519 AAAA... bizinsights-deploy
#
# `restrict` gives that key no terminal, port forwarding, agent or X11; sshd runs this script
# instead of whatever the key asked for, with the request in SSH_ORIGINAL_COMMAND. It accepts the
# two requests `ship.sh` sends with SHIP_GATED=1, and nothing else:
#
#   receive <project> <tag>   the release on stdin (ship.sh's archive) into ~/<project>
#   deploy <project> <tag>    the image bizinsights:<tag> built there, then scripts/deploy.sh <tag>
#
# <project> is bizinsights or bizinsights-staging; <tag> a commit's first 12 hex digits. Anything
# else is refused (exit 2) and logged. Not a sandbox: what it deploys runs under Docker, so the key
# stays a deploy key, kept only in GitHub's secret (docs/ikorex-migration/PRODUCTION_DEPLOYMENT_GUIDE.md,
# "Deploy to iKorex"). The installed copy doesn't update itself: copy it again when this file changes.
#
# ship.sh without SHIP_GATED runs `scripts/ssh-gate.sh deploy <project> <tag>` from the shipped folder,
# so the arguments may also come on the command line (only when SSH_ORIGINAL_COMMAND isn't set).
set -euo pipefail
request="${SSH_ORIGINAL_COMMAND-$*}"

say() {
  echo "ssh-gate: $*" >&2
  command -v logger >/dev/null 2>&1 && logger -t bizinsights-ssh-gate -- "$*" || true
}
refuse() {
  # The request may hold anything: print its printable characters only, and not too many.
  local shown
  shown="$(printf '%s' "$request" | LC_ALL=C tr -cd '[:print:]' | cut -c1-120)"
  say "refused: $1 (request: \"$shown\")"
  exit 2
}

[[ "$request" != *$'\n'* && "$request" != *$'\r'* ]] || refuse "one line only"
read -r verb project tag extra <<<"$request" || true
case "${verb:-}" in receive | deploy) ;; *) refuse "only receive or deploy" ;; esac
[[ "${project:-}" =~ ^bizinsights(-staging)?$ ]] || refuse "project must be bizinsights or bizinsights-staging"
[[ "${tag:-}" =~ ^[0-9a-f]{12}$ ]] || refuse "tag must be 12 hex digits"
[ -z "${extra:-}" ] || refuse "too many words"

dir="$HOME/$project"
case "$verb" in
  receive)
    mkdir -p "$dir"
    cd "$dir"
    umask 022
    # The server's own settings stay as they are, whatever the archive holds (ship.sh leaves them out too).
    tar -xzf - --no-same-owner \
      --exclude='env/*.env' --exclude='.env' \
      --exclude='monitoring/alertmanager.yml' --exclude='monitoring/smtp_password'
    chmod +x scripts/*.sh
    [ -d "releases/$tag/server" ] || { say "receive $project $tag: the archive had no releases/$tag/server"; exit 1; }
    say "received $project $tag"
    ;;
  deploy)
    [ -d "$dir/releases/$tag/server" ] || { say "deploy $project $tag: releases/$tag/server isn't there (receive it first)"; exit 1; }
    cd "$dir"
    say "deploying $project $tag"
    docker build -q -f Dockerfile -t "bizinsights:$tag" "releases/$tag/server" >/dev/null
    exec ./scripts/deploy.sh "$tag"
    ;;
esac
