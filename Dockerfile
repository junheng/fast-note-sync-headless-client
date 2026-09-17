FROM docker.io/library/node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS build
WORKDIR /build
RUN npm install --global pnpm@11.1.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
RUN pnpm install --frozen-lockfile
COPY src/ src/
COPY scripts/build-headless.mjs scripts/headless-entry.mjs scripts/
COPY scripts/lib/ scripts/lib/
RUN pnpm run build:headless

FROM docker.io/library/node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS runtime
RUN apt-get update \
    && apt-get install --yes --no-install-recommends util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o node -g node /vault /state
WORKDIR /app
COPY --from=build /build/dist/headless/cli.cjs ./cli.cjs
COPY LICENSE ./LICENSE
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Fast Note Sync Headless Client" \
      org.opencontainers.image.description="Node bidirectional file sync with durable state; based on the official stable plugin" \
      org.opencontainers.image.source="https://github.com/junheng/fast-note-sync-headless-client" \
      org.opencontainers.image.revision=$VCS_REF
ENV NODE_ENV=production FNS_VAULT_DIR=/vault FNS_STATE_DIR=/state
USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/cli.cjs"]
CMD ["daemon"]
