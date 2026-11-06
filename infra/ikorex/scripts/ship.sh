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

node apps/aws/scripts/build-server.mjs "$@"

echo "sending $tag to $target:~/$project"
# One stream: the bundle under releases/<tag>/server, the Compose project's files at the top
# (env/ and .env stay as they are on the server; only their .example files come along).
tar -C "$root" -czf - \
  --transform "s|^apps/aws/dist/server|releases/$tag/server|" \
  --transform "s|^infra/ikorex/||" \
  --exclude='infra/ikorex/env/*.env' --exclude='infra/ikorex/.env' \
  apps/aws/dist/server infra/ikorex \
  | ssh "$target" "set -e; mkdir -p ~/$project; cd ~/$project; umask 022; tar -xzf - --exclude='env/*.env' --exclude='.env'; chmod +x scripts/*.sh"

ssh "$target" "set -e; cd ~/$project; docker build -q -f Dockerfile -t bizinsights:$tag releases/$tag/server >/dev/null; ./scripts/deploy.sh $tag"
