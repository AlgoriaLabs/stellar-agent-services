# provider-kit gateway image: `provider-kit serve` without installing Node.
#
# Build from the repository root:
#   docker build -f packages/provider-kit/Dockerfile -t provider-kit .
# Run with your config mounted at /config and a volume for the job database:
#   docker run -p 8787:8787 -v "$PWD/provider.config.json:/config/provider.config.json:ro" \
#     -v provider-jobs:/data -e PAY_TO=G... provider-kit
# Set "store": "/data/jobs.sqlite" in the config so paid jobs survive container restarts.
# The image holds no Stellar secret key and needs none.

FROM node:24-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
# npm needs every workspace's package.json to install from the lockfile.
COPY packages/protocol/package.json packages/protocol/
COPY packages/provider-kit/package.json packages/provider-kit/
COPY packages/payment-client/package.json packages/payment-client/
COPY packages/verifier/package.json packages/verifier/
COPY packages/dev-mcp/package.json packages/dev-mcp/
COPY examples/paid-service/package.json examples/paid-service/
COPY apps/wallet/package.json apps/wallet/
RUN npm ci --workspace @stellar-agent-services/provider-kit --include-workspace-root --ignore-scripts
COPY packages/protocol packages/protocol
COPY packages/provider-kit packages/provider-kit
RUN npx tsc -b packages/provider-kit

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/provider-kit/package.json packages/provider-kit/
COPY packages/payment-client/package.json packages/payment-client/
COPY packages/verifier/package.json packages/verifier/
COPY packages/dev-mcp/package.json packages/dev-mcp/
COPY examples/paid-service/package.json examples/paid-service/
COPY apps/wallet/package.json apps/wallet/
RUN npm ci --omit=dev --workspace @stellar-agent-services/provider-kit --ignore-scripts && npm cache clean --force
COPY --from=build /repo/packages/protocol/dist packages/protocol/dist
COPY --from=build /repo/packages/protocol/schemas packages/protocol/schemas
COPY --from=build /repo/packages/provider-kit/dist packages/provider-kit/dist
COPY --from=build /repo/packages/provider-kit/schemas packages/provider-kit/schemas

RUN mkdir -p /config /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["node", "/app/packages/provider-kit/dist/cli/index.js"]
CMD ["serve", "--config", "/config/provider.config.json"]
