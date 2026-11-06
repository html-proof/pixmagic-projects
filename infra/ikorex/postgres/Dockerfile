# PostgreSQL for bizinsights on the iKorex server: the official image (the same major version as RDS,
# 17) with pgBackRest, from the PostgreSQL project's own apt repository (signed, already configured
# in this image). pgBackRest archives the write-ahead log and takes the backups, encrypted, to an
# object store off the server (postgresql.conf, pgbackrest.conf; docs/ikorex-migration).
FROM postgres:17.11-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/spool/pgbackrest /var/log/pgbackrest /tmp/pgbackrest /restore-test \
 && chown -R postgres:postgres /var/spool/pgbackrest /var/log/pgbackrest /tmp/pgbackrest /restore-test

COPY --chown=postgres:postgres pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY --chown=postgres:postgres postgresql.conf /etc/postgresql/postgresql.conf
COPY --chmod=0755 backup-loop.sh restore-test.sh /usr/local/bin/
