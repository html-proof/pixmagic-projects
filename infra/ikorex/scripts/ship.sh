#!/bin/bash
# ship.sh <ssh target> [project] [--skip-web]: build this commit's server bundle here, send it and
# infra/ikorex to the iKorex server, build the image there (for the server's own CPU), and run
# deploy.sh. No registry, and no Docker needed on this machine.
#
#   infra/ikorex/scripts/ship.sh deployer@103.146.112.176                      # production (~/bizinsights)
#   infra/ikorex/scripts/ship.sh deployer@103.146.112.176 bizinsights-staging  # staging (~/bizinsights-staging)
#
# The server folder keeps env/ and .env as they are: only code and configuration are replaced.
set -euo pipefail
target="${1:?usage: ship.sh <ssh target> [project] [--skip-web]}"
shift
project=bizinsights
if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then project="$1"; shift; fi
[[ "$project" =~ ^bizinsights(-staging)?$ ]] || { echo "project must be bizinsights or bizinsights-staging" >&2; exit 2; }
root="$(git rev-parse --show-toplevel)"
cd "$root"
[ -z "$(git status --porcelain)" ] || { echo "the checkout has uncommitted changes: ship a commit" >&2; exit 1; }
tag="$(git rev-parse --short=12 HEAD)"
# Only to the pinned host key (infra/ikorex/known_hosts: the fingerprint in the administrator's
# guide, which copy-db-lib.test.mjs checks). On Windows, Windows' own OpenSSH: it uses the Windows
# ssh-agent, which Git Bash's ssh doesn't.
ssh=ssh
[ -x /c/Windows/System32/OpenSSH/ssh.exe ] && ssh=/c/Windows/System32/OpenSSH/ssh.exe
known="$root/infra/ikorex/known_hosts"
command -v cygpath >/dev/null 2>&1 && known="$(cygpath -m "$known")"
remote() { "$ssh" -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$known" -o IdentitiesOnly=yes "$target" "$@"; }

node apps/aws/scripts/build-server.mjs "$@"

echo "sending $tag to $target:~/$project"
# One stream: the bundle under releases/<tag>/server, the Compose project's files at the top
# (env/ and .env stay as they are on the server; only their .example files come along).
tar -C "$root" -czf - \
  --transform "s|^apps/aws/dist/server|releases/$tag/server|" \
  --transform "s|^infra/ikorex/||" \
  --exclude='infra/ikorex/env/*.env' --exclude='infra/ikorex/.env' \
  --exclude='infra/ikorex/monitoring/alertmanager.yml' --exclude='infra/ikorex/monitoring/smtp_password' \
  apps/aws/dist/server infra/ikorex \
  | remote "set -e; mkdir -p ~/$project; cd ~/$project; umask 022; tar -xzf - --exclude='env/*.env' --exclude='.env'; chmod +x scripts/*.sh"

remote "set -e; cd ~/$project; docker build -q -f Dockerfile -t bizinsights:$tag releases/$tag/server >/dev/null; ./scripts/deploy.sh $tag"
