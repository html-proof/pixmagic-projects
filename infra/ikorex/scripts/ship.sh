#!/bin/bash
# ship.sh: build a commit's server bundle here, send it and infra/ikorex to the iKorex server, build
# the image there (for the server's own CPU), and run deploy.sh. No registry, and no Docker needed
# on this machine.
#
#   infra/ikorex/scripts/ship.sh deployer@103.146.112.176                      # production (~/bizinsights)
#   infra/ikorex/scripts/ship.sh deployer@103.146.112.176 bizinsights-staging  # staging (~/bizinsights-staging)
#
# Or in two halves, as Deploy to iKorex (.github/workflows/ikorex-deploy.yml) runs it: one job
# builds, with every dependency installed and no key; another, with the key and nothing installed,
# sends.
#
#   ship.sh pack <file> [--skip-web]                  this commit's release, in one file; nothing sent
#   ship.sh send <target> <project> <file> [<tag>]    a packed release: sent, image built there, deployed
#
# --skip-web reuses the UI already built in apps/web/out-aws. The server folder keeps env/ and .env
# (and the two files render-monitoring.sh writes) as they are: only code and configuration change.
#
# From the environment:
#   SHIP_SSH_CONFIG  an ssh_config file (ssh -F) naming the target's host, user and key file. ssh is
#                    then the one on PATH (Git Bash's on Windows), not Windows' own, which is used
#                    otherwise for its ssh-agent (the owner's key has a passphrase).
#   SHIP_SSH         the ssh program itself (the tests' stand-in)
#   SHIP_GATED=1     the target's key runs only scripts/ssh-gate.sh on the server (the deploy key):
#                    its two requests are sent instead of shell commands.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
usage() {
  echo "usage: ship.sh <ssh target> [project] [--skip-web]" >&2
  echo "       ship.sh pack <file> [--skip-web]" >&2
  echo "       ship.sh send <ssh target> <project> <file> [<tag>]" >&2
  exit 2
}
check_project() { [[ "$1" =~ ^bizinsights(-staging)?$ ]] || { echo "project must be bizinsights or bizinsights-staging" >&2; exit 2; }; }

# pack <file> [--skip-web]: the bundle under releases/<tag>/server and the Compose project's files at
# the top, as the server folder holds them. env/ and .env stay out (only their .example files come
# along), and so do the two files render-monitoring.sh writes on the server.
pack() {
  [ $# -ge 1 ] || usage
  local file="$1"
  shift
  # (Deploy to iKorex packs into apps/aws/dist, which a fresh checkout doesn't have yet.)
  mkdir -p "$(dirname "$file")"
  file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
  local root tag
  root="$(git -C "$here" rev-parse --show-toplevel)"
  cd "$root"
  [ -z "$(git status --porcelain)" ] || { echo "the checkout has uncommitted changes: ship a commit" >&2; exit 1; }
  tag="$(git rev-parse --short=12 HEAD)"
  node apps/aws/scripts/build-server.mjs "$@"
  # infra/ikorex as committed (git ls-files): no ignored file, and no entry for the folder itself,
  # which would unpack as an empty infra/ikorex/ on the server. The excludes stay as a second guard.
  # (tar's file list comes last: the options before it are positional.)
  { printf 'apps/aws/dist/server\0'; git ls-files -z infra/ikorex; } | tar -C "$root" -czf - \
    --transform "s|^apps/aws/dist/server|releases/$tag/server|" \
    --transform "s|^infra/ikorex/||" \
    --exclude='infra/ikorex/env/*.env' --exclude='infra/ikorex/.env' \
    --exclude='infra/ikorex/monitoring/alertmanager.yml' --exclude='infra/ikorex/monitoring/smtp_password' \
    --null -T - >"$file"
  echo "packed $tag into $file"
}

# Only to the pinned host key (infra/ikorex/known_hosts: the fingerprint in the administrator's
# guide, which copy-db-lib.test.mjs checks).
remote() {
  local ssh="${SHIP_SSH:-ssh}" known config=()
  known="$(cd "$here/.." && pwd)/known_hosts"
  command -v cygpath >/dev/null 2>&1 && known="$(cygpath -m "$known")"
  if [ -n "${SHIP_SSH_CONFIG:-}" ]; then
    config=(-F "$SHIP_SSH_CONFIG")
  elif [ -z "${SHIP_SSH:-}" ] && [ -x /c/Windows/System32/OpenSSH/ssh.exe ]; then
    ssh=/c/Windows/System32/OpenSSH/ssh.exe
  fi
  "$ssh" "${config[@]}" -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$known" -o IdentitiesOnly=yes "$@"
}

# send <target> <project> <file> [<tag>]: the release's tag is read from the file itself.
send() {
  [ $# -ge 3 ] && [ $# -le 4 ] || usage
  local target="$1" project="$2" file="$3" want="${4:-}" tag
  check_project "$project"
  [ -f "$file" ] || { echo "no release file $file" >&2; exit 2; }
  tag="$(tar -tzf - <"$file" | sed -nE 's#^releases/([0-9a-f]{12})/server(/.*)?$#\1#p' | sort -u)"
  [[ "$tag" =~ ^[0-9a-f]{12}$ ]] || { echo "$file holds no single release (found: ${tag:-none})" >&2; exit 1; }
  [ -z "$want" ] || [ "$want" = "$tag" ] || { echo "$file is release $tag, not $want" >&2; exit 1; }

  echo "sending $tag to $target:~/$project"
  if [ "${SHIP_GATED:-}" = 1 ]; then
    remote "$target" "receive $project $tag" <"$file"
    remote "$target" "deploy $project $tag" </dev/null
  else
    remote "$target" "set -e; mkdir -p ~/$project; cd ~/$project; umask 022; tar -xzf - --no-same-owner --exclude='env/*.env' --exclude='.env' --exclude='monitoring/alertmanager.yml' --exclude='monitoring/smtp_password'; chmod +x scripts/*.sh" <"$file"
    remote "$target" "set -e; cd ~/$project; ./scripts/ssh-gate.sh deploy $project $tag" </dev/null
  fi
}

[ $# -gt 0 ] || usage
case "$1" in
  pack) shift; pack "$@" ;;
  send) shift; send "$@" ;;
  -*) usage ;;
  *)
    target="$1"
    shift
    project=bizinsights
    if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then project="$1"; shift; fi
    check_project "$project"
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    pack "$work/release.tgz" "$@"
    send "$target" "$project" "$work/release.tgz"
    ;;
esac
