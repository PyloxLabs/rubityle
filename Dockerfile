FROM node:20-alpine

RUN apk add --no-cache docker-cli bash curl

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY daemon.js ./
COPY config.js logger.js ./
COPY core ./core
COPY api ./api
COPY sftp ./sftp
COPY utils ./utils
COPY .env .env

RUN mkdir -p /var/lib/rubityle /var/log/rubityle

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

VOLUME ["/var/lib/rubityle", "/var/run/docker.sock"]

CMD ["node", "daemon.js"]
