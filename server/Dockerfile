# Doodle Shooter match server (Colyseus) — one long-lived Node.js process
# holding WebSocket connections. Build from this directory:
#
#   docker build -t doodle-shooter-server server/
#   docker run --rm -p 2567:2567 -e ALLOWED_ORIGINS=https://<your-frontend-origin> doodle-shooter-server
#
# See README.md "Deploying" for the environment variables.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
USER node
# The platform may assign another port through PORT; the server reads it.
ENV PORT=2567
EXPOSE 2567
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Node runs as PID 1 and receives SIGTERM directly; Colyseus handles it by
# disposing every room, closing the sockets and exiting.
CMD ["node", "build/index.js"]
