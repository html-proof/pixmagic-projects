# One image, three entrypoints (api | worker | web). Build target selects which.
#   docker build --target api -t insights-api .
FROM node:24-slim AS base
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma packages/db/prisma
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
RUN pnpm install --frozen-lockfile

FROM deps AS source
COPY . .
RUN pnpm --filter @app/db generate

FROM source AS api
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["pnpm", "--filter", "@app/api", "start"]

FROM source AS worker
ENV NODE_ENV=production
USER node
EXPOSE 4100
CMD ["pnpm", "--filter", "@app/worker", "start"]

FROM source AS migrate
CMD ["pnpm", "--filter", "@app/db", "migrate:deploy"]

FROM source AS web-build
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
RUN pnpm --filter @app/web build

FROM web-build AS web
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["pnpm", "--filter", "@app/web", "exec", "next", "start", "-p", "8080"]
