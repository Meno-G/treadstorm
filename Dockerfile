# Treadstorm game server. Build: docker build -t treadstorm .   Run: docker run -p 8787:8787 -e ALLOW_ORIGINS=https://YOU.itch.io,*.itch.zone treadstorm
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY main.js index.html style.css vite.config.js vite.server.config.js ./
COPY server ./server
RUN npm run build:server

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist-server ./dist-server
EXPOSE 8787
USER node
CMD ["node", "dist-server/entry.js"]
