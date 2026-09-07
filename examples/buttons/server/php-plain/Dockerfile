# syntax=docker/dockerfile:1

# Stage 1: the browser side, built with the workspace's Vite — the shared
# vanilla shop client, and the STANDALONE CHECKOUT BUILD (the last step of
# `npm run build:packages`), which vite.config.ts copies into public/openreceive/.
# Same manifest list as the other demos so `npm ci` is one cached layer.
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
COPY examples/buttons/server/django/package.json ./examples/buttons/server/django/package.json
COPY examples/buttons/server/fastapi/package.json ./examples/buttons/server/fastapi/package.json
COPY examples/buttons/server/fastify/package.json ./examples/buttons/server/fastify/package.json
COPY examples/buttons/server/nextjs-fullstack/package.json ./examples/buttons/server/nextjs-fullstack/package.json
COPY examples/buttons/server/node-express/package.json ./examples/buttons/server/node-express/package.json
COPY examples/buttons/server/static-html-small-api/package.json ./examples/buttons/server/static-html-small-api/package.json
COPY examples/buttons/server/rails/package.json ./examples/buttons/server/rails/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit

COPY packages/js ./packages/js
COPY tools/package ./tools/package
COPY tools/shared ./tools/shared
COPY spec/data/rates ./spec/data/rates
# The shop UI, wire types and stylesheet — one copy, read by every stack — and
# this demo's client entry. This demo is not an npm workspace (it has no npm
# dependencies of its own), so the build runs Vite directly.
COPY examples/buttons/shared ./examples/buttons/shared
COPY examples/buttons/server/php-plain/index.html \
  examples/buttons/server/php-plain/package.json \
  examples/buttons/server/php-plain/vite.config.ts \
  ./examples/buttons/server/php-plain/
COPY examples/buttons/server/php-plain/src/client ./examples/buttons/server/php-plain/src/client
RUN npm run build:packages \
  && cd examples/buttons/server/php-plain && npx vite build --configLoader runner

# Stage 2: the PHP host. The engine is installed FROM THE MONOREPO PATH
# (packages/php/openreceive, a Composer path repository), never from Packagist:
# this demo runs the code in this checkout. ext-gmp is REQUIRED by the NWC
# transport; sodium, mbstring and pdo_sqlite ship in the image.
FROM php:8.2-cli
RUN apt-get update \
  && apt-get install -y --no-install-recommends git libgmp-dev unzip \
  && docker-php-ext-install gmp \
  && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /app
COPY packages/php/openreceive ./packages/php/openreceive
COPY examples/buttons/server/php-plain/composer.json ./examples/buttons/server/php-plain/
WORKDIR /app/examples/buttons/server/php-plain
# Dependencies before the app source: editing a route reuses this layer.
RUN composer install --no-interaction --no-progress --prefer-dist --no-dev
WORKDIR /app
# shop-catalog.json is the seed the migration reads; images/ is the artwork.
COPY examples/buttons/shared/shop-catalog.json ./examples/buttons/shared/shop-catalog.json
COPY examples/buttons/images ./examples/buttons/images
COPY examples/buttons/server/php-plain/public/index.php ./examples/buttons/server/php-plain/public/index.php
COPY examples/buttons/server/php-plain/src/*.php ./examples/buttons/server/php-plain/src/
COPY examples/buttons/server/php-plain/bin ./examples/buttons/server/php-plain/bin
COPY --from=client /app/examples/buttons/server/php-plain/public ./examples/buttons/server/php-plain/public

WORKDIR /app/examples/buttons/server/php-plain
ENV PORT=3008 \
    OPENRECEIVE_DEMO_DB=/data \
    PHP_CLI_SERVER_WORKERS=4
EXPOSE 3008
# `php -S` is PHP's development server, run here with a few forked workers so
# the browser's parallel fetches do not queue behind one wallet call. It is
# what makes this image self-contained; a deployment puts PHP-FPM or Apache in
# front of the same public/index.php (see the README).
CMD ["sh", "-c", "php -S 0.0.0.0:${PORT} -t public public/index.php"]
