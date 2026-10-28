# {{name}}: the Provider Kit gateway in front of your API, with its job database, on any host that runs a container.
#
#   docker build -t {{package}} .
#   docker run -p 8787:8787 -v {{package}}-jobs:/data -e PAY_TO=G... -e PUBLIC_ORIGIN=https://your.domain {{package}}
#
# In the container, 127.0.0.1 is the container itself: point each upstream.url in provider.config.json at an address
# the container reaches your API on. Paid jobs are kept in /data/jobs.sqlite: give /data a persistent volume. The
# image holds no Stellar secret key.

FROM node:24-slim
ENV NODE_ENV=production JOB_DB_PATH=/data/jobs.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
{{vendor}}
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY provider.config.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "node_modules/@stellar-agent-services/provider-kit/dist/cli/index.js", "serve", "--config", "provider.config.json"]
