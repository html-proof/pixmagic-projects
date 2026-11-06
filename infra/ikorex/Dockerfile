# bizinsights' self-hosted image (docs/ikorex-migration): the bundle `node apps/aws/scripts/build-server.mjs`
# makes, run by Node. No source, no node_modules, no build tools.
#
#   node apps/aws/scripts/build-server.mjs
#   docker build -f infra/ikorex/Dockerfile -t bizinsights:<commit> apps/aws/dist/server
#
# One image, three commands (infra/ikorex/docker-compose.yml): `server.mjs web`, `server.mjs worker`,
# `admin.mjs <command>`.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    METRICS_PORT=9464 \
    BLOB_DIR=/data/blobs

WORKDIR /app
COPY . /app/
# The blob folder belongs to the unprivileged user the server runs as; the volume mounted there
# takes these permissions the first time.
RUN mkdir -p /data/blobs && chown node:node /data/blobs

USER node
EXPOSE 8080 9464

# The web role's own check; the worker's is set in the Compose file (it answers on the metrics port).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/__health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["node"]
CMD ["server.mjs", "web"]
