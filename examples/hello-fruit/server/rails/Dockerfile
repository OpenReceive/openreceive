# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS client
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages/js ./packages/js
COPY examples/hello-fruit/shared ./examples/hello-fruit/shared
COPY examples/hello-fruit/server/nextjs-fullstack/package.json \
  ./examples/hello-fruit/server/nextjs-fullstack/package.json
COPY examples/hello-fruit/server/node-express/package.json \
  ./examples/hello-fruit/server/node-express/package.json
COPY examples/hello-fruit/server/static-html-small-api/package.json \
  ./examples/hello-fruit/server/static-html-small-api/package.json
COPY examples/hello-fruit/server/rails/package.json \
  ./examples/hello-fruit/server/rails/package.json
COPY tools/package ./tools/package
COPY tools/run-with-root-env.mjs ./tools/run-with-root-env.mjs
COPY spec/data/rates ./spec/data/rates
RUN npm ci --no-audit
# Shakapacker build inputs: config (shakapacker.yml, webpack, swc), PostCSS,
# and the app/javascript source tree. Output lands in public/packs.
COPY examples/hello-fruit/server/rails/config \
  ./examples/hello-fruit/server/rails/config
COPY examples/hello-fruit/server/rails/postcss.config.js \
  examples/hello-fruit/server/rails/tsconfig.json \
  ./examples/hello-fruit/server/rails/
COPY examples/hello-fruit/server/rails/app/javascript \
  ./examples/hello-fruit/server/rails/app/javascript
# Bump via compose CLIENT_BUILD_ID so `npm run demo rails` rebuilds JS even when
# BuildKit would otherwise reuse a cached webpack output from an older checkout.
ARG CLIENT_BUILD_ID=
RUN npm run build:packages \
  && npm run build -w @openreceive/example-rails

FROM ruby:3.4-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    pkg-config \
    autoconf \
    automake \
    libtool \
    libsecp256k1-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY packages/ruby ./packages/ruby
COPY examples/hello-fruit/shared ./examples/hello-fruit/shared
COPY examples/hello-fruit/server/rails ./examples/hello-fruit/server/rails
# Host webpack output is dockerignored/stale. Overlay the client-stage bundle;
# Shakapacker's production manifest (public/packs/manifest.json) is the digest
# authority, so no assets:precompile pass is needed in this stage.
RUN rm -rf ./examples/hello-fruit/server/rails/public/packs \
  ./examples/hello-fruit/server/rails/public/index.html \
  ./examples/hello-fruit/server/rails/public/assets \
  ./examples/hello-fruit/server/rails/node_modules
COPY --from=client /app/examples/hello-fruit/server/rails/public/packs \
  ./examples/hello-fruit/server/rails/public/packs

WORKDIR /app/examples/hello-fruit/server/rails

# Catalog thumbnails: shared stickers via public/ (same source as Node demos).
RUN ln -sfn ../../../shared/stickers public/stickers

RUN bundle config set --local path vendor/bundle \
  && bundle install --jobs 4 \
  && chmod +x bin/docker-entrypoint

ENTRYPOINT ["./bin/docker-entrypoint"]

ENV RAILS_ENV=production \
    RAILS_LOG_TO_STDOUT=1 \
    PORT=3003

EXPOSE 3003
CMD ["bundle", "exec", "puma", "-C", "config/puma.rb", "-b", "tcp://0.0.0.0:3003"]
