# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

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
COPY examples/buttons/server/nextjs-fullstack/package.json ./examples/buttons/server/nextjs-fullstack/package.json
COPY examples/buttons/server/node-express/package.json ./examples/buttons/server/node-express/package.json
COPY examples/buttons/server/static-html-small-api/package.json ./examples/buttons/server/static-html-small-api/package.json
COPY examples/buttons/server/rails/package.json ./examples/buttons/server/rails/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit

COPY packages ./packages
COPY tools/package ./tools/package
COPY tools/shared ./tools/shared
COPY tools/run-with-root-env.mjs ./tools/run-with-root-env.mjs
COPY spec/data/rates ./spec/data/rates
# The whole demo: the shared client and server, the wire types, the seed
# catalog and the one copy of the artwork. Every stack reads that directory.
COPY examples/buttons ./examples/buttons
RUN npm run build:packages
RUN npm run build -w @openreceive/example-buttons-static-html

WORKDIR /app/examples/buttons/server/static-html-small-api
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

CMD ["npm", "start"]
