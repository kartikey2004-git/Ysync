# syntax=docker/dockerfile:1
#
# Builds apps/server (the YSync realtime WS/HTTP server) and its three
# in-repo workspace dependencies (packages/crdt, packages/protocol,
# packages/database). apps/web is a separate Next.js app deployed to
# Cloudflare via OpenNext (see apps/web/wrangler.jsonc) and is intentionally
# excluded from this image — see deployments.md "Architecture overview".

FROM node:22-alpine AS build
WORKDIR /app

RUN npm install -g pnpm@12.6.0

# Copy workspace config and lockfile first for layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./

# pnpm needs all workspace package.json files to resolve the dependency graph.
# Only apps/server source is needed for the build; apps/web is stub-only.
COPY packages/crdt/package.json packages/crdt/
COPY packages/database/package.json packages/database/
COPY packages/protocol/package.json packages/protocol/
COPY packages/ui/package.json packages/ui/
COPY apps/server/package.json apps/server/

RUN pnpm install --no-frozen-lockfile

# Copy full source now (after install for better layer caching)
COPY packages ./packages
COPY apps/server ./apps/server

# packages/database/prisma.config.ts calls prisma/config's env("DATABASE_URL")
# at config-load time, so `prisma generate` fails fast without *some* value
# resolvable for DATABASE_URL — even though generation itself never connects
# to a database. This placeholder is build-time only; the real value is
# injected at deploy time.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"

# Prisma 7 has no default Rust query engine — the generated client
# (packages/database/generated/prisma) does not exist until this runs, and
# packages/database's own `tsc` build imports from it.
RUN pnpm --filter @ysync/database db:generate

# Dependency-ordered build (pnpm --filter does not topologically sort here):
# crdt and database have no in-repo deps; protocol imports crdt's dist;
# server imports all three.
RUN pnpm --filter @ysync/crdt build \
 && pnpm --filter @ysync/database build \
 && pnpm --filter @ysync/protocol build \
 && pnpm --filter @ysync/server build

# NOTE: devDependencies are intentionally NOT pruned here. Prisma 7's
# generated client (packages/database/generated/prisma/client.ts) emits
# relative imports without file extensions, e.g. `import * as $Class from
# "./internal/class"`. That's invalid under Node's strict ESM resolution, so
# `node dist/index.js` crashes with ERR_MODULE_NOT_FOUND the moment it loads
# @ysync/database — verified by running this image with that CMD. `tsx`'s
# module resolver tolerates extensionless specifiers, which is exactly why
# apps/server/package.json's own `start` script is `tsx src/index.ts` rather
# than `node dist/index.js`, even though a `build`/`dist` exists.


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S ysync && adduser -S ysync -G ysync

COPY --from=build --chown=ysync:ysync /app/node_modules ./node_modules
COPY --from=build --chown=ysync:ysync /app/package.json ./package.json
COPY --from=build --chown=ysync:ysync /app/packages ./packages
COPY --from=build --chown=ysync:ysync /app/apps/server ./apps/server

USER ysync
WORKDIR /app/apps/server

# Cloud Run injects PORT (default 8080); apps/server/src/index.ts already
# reads process.env.PORT ?? 8080, so no code change is required.
EXPOSE 8080

CMD ["npx", "tsx", "src/index.ts"]
