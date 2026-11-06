#!/bin/bash
# The WhatsApp service's (Evolution API's) start on the iKorex server: the same as START in
# infra/cdk/lib/whatsapp-stack.ts, keep the two alike. Evolution's image runs its database
# migrations and then the server; the database address is put together here so the password
# never sits in the Compose file, and only DATABASE_CONNECTION_URI is set (the image's start script
# prints DATABASE_URL to the log, which stays unset). The database is on the private Compose
# network, so no TLS here (RDS needed it).
set -eo pipefail
export DATABASE_CONNECTION_URI="postgresql://${EVO_DB_USER}:${EVO_DB_PASSWORD}@${EVO_DB_HOST:-postgres}:${EVO_DB_PORT:-5432}/evolution?schema=public&connection_limit=5"
unset EVO_DB_PASSWORD
. ./Docker/scripts/deploy_database.sh
# Only Evolution's own logger reaches the logs from the console, whichever method is called: it
# prints through console.log, every line starting with "[Evolution API]" (LOG_COLOR=false), its
# ERROR and WARN lines included. Everything else is dropped: Evolution's stray console.log calls
# print every message received, numbers and text, and libsignal prints whole Signal sessions,
# private keys included (whatsapp-stack.ts has the details). Baileys' own JSON logger writes to
# stdout itself and is left as it is.
cat > /tmp/quiet-console.cjs <<'JS'
const evolution = (a) => typeof a[0] === "string" && a[0].startsWith("[Evolution API]");
for (const m of ["log", "info", "debug", "warn", "error", "trace", "dir", "dirxml", "table", "group", "groupCollapsed", "assert", "count", "timeLog", "timeEnd"]) {
  const print = console[m];
  console[m] = (...a) => { if (evolution(a)) print(...a); };
}
JS
exec node --require /tmp/quiet-console.cjs dist/main
