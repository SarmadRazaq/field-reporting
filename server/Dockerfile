# Field Reports upload server, for Fly.io (or any Docker host).
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# tsx runs the TypeScript directly, so dev dependencies are installed too.
COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV PORT=4000 DATA_DIR=/data
EXPOSE 4000
CMD ["npx", "tsx", "src/index.ts"]
