# {{name}}: the FastAPI app and the Provider Kit gateway in one container. The app listens on 127.0.0.1:8000, inside
# the container only, and the gateway on port 8787, in front of it.
#
#   docker build -t {{package}} .
#   docker run -p 8787:8787 -v {{package}}-jobs:/data -e PAY_TO=G... -e PUBLIC_ORIGIN=https://your.domain {{package}}
#
# Paid jobs are kept in /data/jobs.sqlite: give /data a persistent volume. The image holds no Stellar secret key.
# fly.toml deploys it on Fly.io: npm run launch does, or npm run deploy.

FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production JOB_DB_PATH=/data/jobs.sqlite PATH=/opt/venv/bin:$PATH
WORKDIR /app
COPY requirements.txt ./
RUN python3 -m venv /opt/venv && pip install --no-cache-dir -r requirements.txt
COPY package.json package-lock.json ./
{{vendor}}
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY app.py provider.config.json start.sh ./
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# A host's new volume may belong to root, as Fly.io's do: started as root, the container only gives /data to the node
# user, then runs the service as node. Started as another user, it runs as that user.
ENTRYPOINT ["sh", "-c", "if [ \"$(id -u)\" = 0 ]; then chown node:node /data 2>/dev/null || true; exec setpriv --reuid=node --regid=node --init-groups -- \"$@\"; fi; exec \"$@\"", "sh"]
CMD ["sh", "start.sh"]
