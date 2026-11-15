FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends stockfish ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /data && chown -R node:node /app /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data STOCKFISH_PATH=/usr/games/stockfish
USER node
EXPOSE 8787
CMD ["node", "src/server.mjs"]
