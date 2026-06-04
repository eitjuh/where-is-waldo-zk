FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile || pnpm install

COPY . .
RUN pnpm real:bundle

ENV HOST=127.0.0.1
ENV PORT=4174
ENV ZK_WALDO_ALLOW_COORDINATE_WITNESS=0
ENV ZK_WALDO_TRUST_REMOTE=0

EXPOSE 4174
CMD ["node", "scripts/real-demo-server.mjs"]
