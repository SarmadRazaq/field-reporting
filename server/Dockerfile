# Field Reports upload server, for Fly.io (or any Docker host).

# Build stage: has a compiler in case better-sqlite3 or sharp has no prebuilt binary.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
# tsx runs the TypeScript directly, so dev dependencies are installed too.
COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV PORT=4000 DATA_DIR=/data
EXPOSE 4000
CMD ["npx", "tsx", "src/index.ts"]
