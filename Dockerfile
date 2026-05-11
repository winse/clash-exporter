# Clash Prometheus exporter — Node 22 Alpine
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.mjs ./
COPY lib ./lib

ENV NODE_ENV=production
EXPOSE 2112

RUN chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:2112/health || exit 1

CMD ["node", "server.mjs"]
