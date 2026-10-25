FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared-types/package.json shared-types/tsconfig.json ./shared-types/
COPY tee-worker/package.json tee-worker/tsconfig.json ./tee-worker/
COPY escrow-contract/package.json ./escrow-contract/
RUN pnpm install --frozen-lockfile
COPY shared-types/src ./shared-types/src
COPY tee-worker/src ./tee-worker/src
RUN pnpm --filter @air-otc/shared-types build && pnpm --filter @air-otc/tee-worker build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
RUN useradd --create-home --uid 10001 worker && mkdir -p /var/lib/airotc && chown worker:worker /var/lib/airotc
WORKDIR /workspace
COPY --from=build --chown=worker:worker /workspace /workspace
USER worker
EXPOSE 8080
WORKDIR /workspace/tee-worker
CMD ["node", "dist/index.js"]

