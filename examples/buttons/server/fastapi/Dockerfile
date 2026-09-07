# syntax=docker/dockerfile:1

# Stage 1: the React client, built with the workspace's Vite. Same manifest
# list as the Node demos so `npm ci` is one cached layer.
FROM node:22-bookworm-slim AS client
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages/js/angular/package.json ./packages/js/angular/package.json
COPY packages/js/browser/package.json ./packages/js/browser/package.json
COPY packages/js/core/package.json ./packages/js/core/package.json
COPY packages/js/elements/package.json ./packages/js/elements/package.json
COPY packages/js/express/package.json ./packages/js/express/package.json
COPY packages/js/fastify/package.json ./packages/js/fastify/package.json
COPY packages/js/http/package.json ./packages/js/http/package.json
COPY packages/js/next/package.json ./packages/js/next/package.json
COPY packages/js/node/package.json ./packages/js/node/package.json
COPY packages/js/openreceive/package.json ./packages/js/openreceive/package.json
COPY packages/js/provider-data/package.json ./packages/js/provider-data/package.json
COPY packages/js/react/package.json ./packages/js/react/package.json
COPY packages/js/svelte/package.json ./packages/js/svelte/package.json
COPY packages/js/testkit/package.json ./packages/js/testkit/package.json
COPY packages/js/vue/package.json ./packages/js/vue/package.json
COPY examples/buttons/server/fastapi/package.json ./examples/buttons/server/fastapi/package.json
COPY examples/buttons/server/django/package.json ./examples/buttons/server/django/package.json
COPY examples/buttons/server/fastify/package.json ./examples/buttons/server/fastify/package.json
COPY examples/buttons/server/nextjs-fullstack/package.json ./examples/buttons/server/nextjs-fullstack/package.json
COPY examples/buttons/server/node-express/package.json ./examples/buttons/server/node-express/package.json
COPY examples/buttons/server/static-html-small-api/package.json ./examples/buttons/server/static-html-small-api/package.json
COPY examples/buttons/server/rails/package.json ./examples/buttons/server/rails/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit

COPY packages/js ./packages/js
COPY tools/package ./tools/package
COPY tools/shared ./tools/shared
COPY tools/run-with-root-env.mjs ./tools/run-with-root-env.mjs
COPY spec/data/rates ./spec/data/rates
# The shop UI, stores and wire types — one copy, read by every stack — and
# this demo's client entry.
COPY examples/buttons/shared ./examples/buttons/shared
COPY examples/buttons/server/fastapi/index.html \
  examples/buttons/server/fastapi/vite.config.ts \
  ./examples/buttons/server/fastapi/
COPY examples/buttons/server/fastapi/src ./examples/buttons/server/fastapi/src
RUN npm run build:packages \
  && npm run build -w @openreceive/example-buttons-fastapi

# Stage 2: the Python host. The engine is installed FROM THE MONOREPO PATH
# (packages/python/openreceive), never from PyPI: this demo runs the code in
# this checkout. uv comes from its official image; no pip, no system python
# 3.9 anywhere near it.
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.10 /uv /uvx /bin/
WORKDIR /app
COPY packages/python/openreceive ./packages/python/openreceive
COPY examples/buttons/server/fastapi/pyproject.toml \
  examples/buttons/server/fastapi/uv.lock \
  ./examples/buttons/server/fastapi/
WORKDIR /app/examples/buttons/server/fastapi
# Dependencies before the app source: editing a route reuses this layer.
RUN uv sync --frozen --no-dev
WORKDIR /app
# shop-catalog.json is the seed the migration reads; images/ is the artwork.
COPY examples/buttons/shared/shop-catalog.json ./examples/buttons/shared/shop-catalog.json
COPY examples/buttons/images ./examples/buttons/images
COPY examples/buttons/server/fastapi/server ./examples/buttons/server/fastapi/server
COPY --from=client /app/examples/buttons/server/fastapi/dist ./examples/buttons/server/fastapi/dist

WORKDIR /app/examples/buttons/server/fastapi
ENV PORT=3007 \
    OPENRECEIVE_DEMO_DB=/data
EXPOSE 3007
# --proxy-headers: behind a reverse proxy request.client is the payer, so the
# per-IP invoice cap counts the right thing.
CMD ["uv", "run", "--frozen", "--no-dev", "uvicorn", "server.asgi:app", "--host", "0.0.0.0", "--port", "3007", "--proxy-headers"]
