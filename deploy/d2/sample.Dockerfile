# D2 sample provider from this checkout. Public settings only; durable jobs live on the mounted /data volume.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY examples/paid-service ./examples/paid-service
COPY apps/wallet/package.json ./apps/wallet/package.json
RUN npm ci --ignore-scripts && node node_modules/typescript/bin/tsc -b examples/paid-service
RUN npm prune --omit=dev --ignore-scripts

FROM node:24-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production PORT=8787 STELLAR_NETWORK=stellar:testnet JOB_DB_PATH=/data/jobs.sqlite
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["sh", "-c", "if [ \"$(id -u)\" = 0 ]; then chown node:node /data 2>/dev/null || true; exec setpriv --reuid=node --regid=node --init-groups -- \"$@\"; fi; exec \"$@\"", "sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "examples/paid-service/dist/server.js"]
