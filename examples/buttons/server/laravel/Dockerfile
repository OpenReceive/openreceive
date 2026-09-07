# syntax=docker/dockerfile:1

# Stage 1: the browser bundle. The shared React shop and the OpenReceive
# packages are built with Node; Vite emits public/build with the manifest the
# Blade @vite directive reads.
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
COPY examples/buttons/server/fastify/package.json ./examples/buttons/server/fastify/package.json
COPY examples/buttons/server/laravel/package.json ./examples/buttons/server/laravel/package.json
COPY examples/buttons/server/nextjs-fullstack/package.json ./examples/buttons/server/nextjs-fullstack/package.json
COPY examples/buttons/server/node-express/package.json ./examples/buttons/server/node-express/package.json
COPY examples/buttons/server/static-html-small-api/package.json ./examples/buttons/server/static-html-small-api/package.json
COPY examples/buttons/server/rails/package.json ./examples/buttons/server/rails/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit

COPY packages/js ./packages/js
COPY tools/package ./tools/package
COPY tools/shared ./tools/shared
COPY spec/data/rates ./spec/data/rates
# The shared client, the wire types and the seed catalog. Every stack reads that directory.
COPY examples/buttons/shared ./examples/buttons/shared
COPY examples/buttons/server/laravel/vite.config.ts \
  examples/buttons/server/laravel/tsconfig.json \
  ./examples/buttons/server/laravel/
COPY examples/buttons/server/laravel/vite ./examples/buttons/server/laravel/vite
COPY examples/buttons/server/laravel/resources ./examples/buttons/server/laravel/resources
RUN npm run build:packages \
  && npm run build -w @openreceive/example-buttons-laravel

# Stage 2: PHP 8.2 + Apache. ext-gmp is REQUIRED by the NWC transport's
# elliptic-curve math; pdo_pgsql for the host Postgres; pcntl so the
# notifications worker stops cleanly on SIGTERM.
FROM php:8.2-apache

RUN apt-get update \
  && apt-get install -y --no-install-recommends git libgmp-dev libpq-dev unzip \
  && docker-php-ext-install gmp pdo_pgsql pcntl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /app

# The two Composer packages resolve through the demo's path repositories, so
# they are copied in from the monorepo — never fetched from Packagist here.
COPY packages/php ./packages/php
COPY examples/buttons/server/laravel/composer.json \
  examples/buttons/server/laravel/composer.lock \
  ./examples/buttons/server/laravel/
WORKDIR /app/examples/buttons/server/laravel
# `composer install` is the most expensive step; it sits above the app-source
# COPY, keyed on the two manifests alone, so editing a controller does not
# reinstall every package.
RUN composer install --no-dev --no-interaction --no-progress --prefer-dist --no-scripts --no-autoloader

WORKDIR /app
COPY examples/buttons/shared ./examples/buttons/shared
COPY examples/buttons/images ./examples/buttons/images
COPY examples/buttons/server/laravel ./examples/buttons/server/laravel
COPY --from=client /app/examples/buttons/server/laravel/public/build \
  ./examples/buttons/server/laravel/public/build

WORKDIR /app/examples/buttons/server/laravel
RUN composer dump-autoload --no-dev --optimize --no-interaction \
  && php artisan package:discover --ansi \
  && cp docker/apache-vhost.conf /etc/apache2/sites-available/000-default.conf \
  && chown -R www-data:www-data storage bootstrap/cache

ENV APP_ENV=production \
    APP_DEBUG=false \
    LOG_CHANNEL=stderr \
    PORT=3005

ENTRYPOINT ["./bin/docker-entrypoint"]

EXPOSE 3005
CMD ["apache2-foreground"]
