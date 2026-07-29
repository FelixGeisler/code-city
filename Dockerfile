# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS node-runtime

FROM mcr.microsoft.com/dotnet/sdk:10.0.302-noble AS build
COPY --from=node-runtime /usr/local/ /usr/local/
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM mcr.microsoft.com/dotnet/runtime:10.0-noble AS runtime
COPY --from=node-runtime /usr/local/ /usr/local/

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 codecity \
    && useradd --system --uid 10001 --gid codecity --home-dir /app codecity \
    && mkdir --parents /app /data \
    && chown codecity:codecity /app /data

WORKDIR /app
COPY --from=build --chown=codecity:codecity /app/build ./build
COPY --from=build --chown=codecity:codecity /app/node_modules ./node_modules
COPY --from=build --chown=codecity:codecity /app/package.json ./package.json
COPY --from=build --chown=codecity:codecity /app/tools/roslyn-helper/bin/Release/net10.0 ./tools/roslyn-helper/bin/Release/net10.0

ENV CODECITY_HOST=0.0.0.0 \
    CODECITY_PORT=3000 \
    CODECITY_DATA_DIR=/data \
    NODE_ENV=production

USER codecity
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.CODECITY_PORT + '/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "build/app/apps/server/src/main.js"]
