# {{name}}: the service and its job database, on any host that runs a container.
#
#   docker build -t {{package}} .
#   docker run -p 8787:8787 -v {{package}}-jobs:/data -e PAY_TO=G... -e PUBLIC_ORIGIN=https://your.domain {{package}}
#
# Paid jobs are kept in /data/jobs.sqlite: give /data a persistent volume. The image holds no Stellar secret key.
# fly.toml deploys it on Fly.io: npm run launch does, or npm run deploy.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
{{vendor}}
RUN npm ci --ignore-scripts
COPY src ./src
RUN npx tsc

FROM node:24-slim
ENV NODE_ENV=production JOB_DB_PATH=/data/jobs.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
{{vendor}}
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# A host's new volume may belong to root, as Fly.io's do: started as root, the container only gives /data to the node
# user, then runs the service as node. Started as another user, it runs as that user.
ENTRYPOINT ["sh", "-c", "if [ \"$(id -u)\" = 0 ]; then chown node:node /data 2>/dev/null || true; exec setpriv --reuid=node --regid=node --init-groups -- \"$@\"; fi; exec \"$@\"", "sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.js"]
