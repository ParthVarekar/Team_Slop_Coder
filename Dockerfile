FROM node:24-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/core/package.json packages/core/package.json
COPY apps/server/package.json apps/server/package.json
RUN pnpm install --filter @weft/server... --frozen-lockfile
COPY packages/protocol packages/protocol
COPY packages/core packages/core
COPY apps/server apps/server
RUN pnpm exec tsc -b apps/server/tsconfig.json \
    && pnpm --filter @weft/server deploy --legacy --prod /out

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    WEFT_SERVER_HOST=0.0.0.0 \
    WEFT_SERVER_PORT=7420 \
    WEFT_SERVER_DATA_DIR=/var/lib/weft
WORKDIR /app
RUN mkdir -p /var/lib/weft && chown node:node /var/lib/weft
COPY --from=build --chown=node:node /out/ ./
USER node
EXPOSE 7420
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEFT_SERVER_PORT||7420)+'/healthz').then(r=>r.json()).then(h=>process.exit(h.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["start"]
