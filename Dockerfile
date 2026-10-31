FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY .env.example ./.env.example
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/delivery.sqlite COOKIE_SECURE=true
EXPOSE 3000
CMD ["node", "src/server.mjs"]
