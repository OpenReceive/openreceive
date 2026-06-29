# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends g++ libsqlite3-dev make python3 sqlite3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json ./
COPY packages/js/angular/package.json ./packages/js/angular/package.json
COPY packages/js/browser/package.json ./packages/js/browser/package.json
COPY packages/js/core/package.json ./packages/js/core/package.json
COPY packages/js/elements/package.json ./packages/js/elements/package.json
COPY packages/js/node/package.json ./packages/js/node/package.json
COPY packages/js/provider-data/package.json ./packages/js/provider-data/package.json
COPY packages/js/react/package.json ./packages/js/react/package.json
COPY packages/js/svelte/package.json ./packages/js/svelte/package.json
COPY packages/js/testkit/package.json ./packages/js/testkit/package.json
COPY packages/js/vue/package.json ./packages/js/vue/package.json
COPY examples/hello-fruit/server/nextjs-fullstack/package.json ./examples/hello-fruit/server/nextjs-fullstack/package.json
COPY examples/hello-fruit/server/node-express/package.json ./examples/hello-fruit/server/node-express/package.json
COPY examples/hello-fruit/server/static-html-small-api/package.json ./examples/hello-fruit/server/static-html-small-api/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit
RUN --mount=type=cache,target=/root/.npm npm install sqlite3@5.1.7 ws@8.18.3 --no-save --no-audit

COPY packages ./packages
COPY tools/package ./tools/package
COPY spec/data/rates ./spec/data/rates
COPY examples/hello-fruit ./examples/hello-fruit
RUN npm run build:packages
RUN npm run build -w @openreceive/example-static-html-small-api

WORKDIR /app/examples/hello-fruit/server/static-html-small-api
ENV NODE_ENV=production
ENV OPENRECEIVE_DEMO_MODE=test_nwc
ENV PORT=3001
EXPOSE 3001

CMD ["npm", "start"]
