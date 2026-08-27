# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS client
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages/js ./packages/js
# The shop UI, stores and wire types. One copy, read by every stack.
COPY examples/buttons/shared ./examples/buttons/shared
COPY examples/hello-fruit/shared ./examples/hello-fruit/shared
COPY examples/hello-fruit/server/nextjs-fullstack/package.json \
  ./examples/hello-fruit/server/nextjs-fullstack/package.json
COPY examples/hello-fruit/server/node-express/package.json \
  ./examples/hello-fruit/server/node-express/package.json
COPY examples/hello-fruit/server/static-html-small-api/package.json \
  ./examples/hello-fruit/server/static-html-small-api/package.json
COPY examples/buttons/server/rails/package.json \
  ./examples/buttons/server/rails/package.json
COPY tools/package ./tools/package
COPY tools/shared ./tools/shared
COPY tools/run-with-root-env.mjs ./tools/run-with-root-env.mjs
COPY spec/data/rates ./spec/data/rates
RUN npm ci --no-audit
# Shakapacker build inputs: config (shakapacker.yml, webpack, swc), PostCSS,
# and the app/javascript source tree. Output lands in public/packs.
COPY examples/buttons/server/rails/config \
  ./examples/buttons/server/rails/config
COPY examples/buttons/server/rails/postcss.config.js \
  examples/buttons/server/rails/tsconfig.json \
  ./examples/buttons/server/rails/
COPY examples/buttons/server/rails/app/javascript \
  ./examples/buttons/server/rails/app/javascript
# Bump via compose CLIENT_BUILD_ID so `npm run demo buttons` rebuilds JS even
# when BuildKit would otherwise reuse a cached webpack output from an older
# checkout.
ARG CLIENT_BUILD_ID=
RUN npm run build:packages \
  && npm run build -w @openreceive/example-buttons-rails

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
# shared/ carries shop-catalog.json, which the data migration and db/seeds.rb
# both read. images/ is the artwork, on the Propshaft load path.
COPY examples/buttons/shared ./examples/buttons/shared
COPY examples/buttons/images ./examples/buttons/images
COPY examples/buttons/server/rails ./examples/buttons/server/rails
# Host webpack output is dockerignored/stale. Overlay the client-stage bundle;
# Shakapacker's production manifest (public/packs/manifest.json) is the digest
# authority for the JS and CSS.
RUN rm -rf ./examples/buttons/server/rails/public/packs \
  ./examples/buttons/server/rails/public/assets \
  ./examples/buttons/server/rails/node_modules
COPY --from=client /app/examples/buttons/server/rails/public/packs \
  ./examples/buttons/server/rails/public/packs

WORKDIR /app/examples/buttons/server/rails

RUN bundle config set --local path vendor/bundle \
  && bundle install --jobs 4 \
  && chmod +x bin/docker-entrypoint

ENV RAILS_ENV=production \
    RAILS_LOG_TO_STDOUT=1 \
    PORT=3003

# Propshaft digests for the six button images. `asset_path` must return a
# digested URL in production, because the catalog ships those URLs to the
# browser in the bootstrap payload and the browser cannot derive them.
#
# This does NOT touch public/packs: that is webpack's output, the client stage
# built it, and it is not on the Propshaft load path.
# `shakapacker_precompile: false` is what keeps webpack out of this pass —
# there are no node_modules in this stage.
RUN SECRET_KEY_BASE_DUMMY=1 bundle exec rails assets:precompile

# One image, two roles: the web process and the `notifications` worker in
# compose.yml run the same build with different commands.
ENTRYPOINT ["./bin/docker-entrypoint"]

EXPOSE 3003
CMD ["bundle", "exec", "puma", "-C", "config/puma.rb", "-b", "tcp://0.0.0.0:3003"]
