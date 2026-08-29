# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS client
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
# Workspace manifests only. `npm ci` reads no source, so editing a library below
# reuses this install instead of redoing it.
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

COPY packages/js ./packages/js
# The shop UI, stores and wire types. One copy, read by every stack.
COPY examples/buttons/shared ./examples/buttons/shared
COPY tools/package ./tools/package
COPY tools/shared ./tools/shared
COPY tools/run-with-root-env.mjs ./tools/run-with-root-env.mjs
COPY spec/data/rates ./spec/data/rates
# Shakapacker build inputs: config (shakapacker.yml, webpack, swc), PostCSS,
# and the app/javascript source tree. Output lands in public/packs.
#
# Those COPYs above are the complete input set, and BuildKit keys this layer on
# their contents — so the bundle rebuilds exactly when a source it reads
# changes, and is reused when none did. The host's own public/packs never
# reaches the context (.dockerignore) and is deleted in the Ruby stage below,
# so a stale checkout cannot leak in and there is nothing here to force past.
COPY examples/buttons/server/rails/config \
  ./examples/buttons/server/rails/config
COPY examples/buttons/server/rails/postcss.config.js \
  examples/buttons/server/rails/tsconfig.json \
  ./examples/buttons/server/rails/
COPY examples/buttons/server/rails/app/javascript \
  ./examples/buttons/server/rails/app/javascript
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

# BUNDLE BEFORE THE APP SOURCE. `bundle install` is the most expensive step in
# this stage and it reads only the two manifests plus the path gems — so those
# are all that is copied here. Editing a controller or a view then rebuilds
# from the copy below, with the gems already installed.
COPY packages/ruby ./packages/ruby
COPY examples/buttons/server/rails/Gemfile \
  examples/buttons/server/rails/Gemfile.lock \
  ./examples/buttons/server/rails/
WORKDIR /app/examples/buttons/server/rails
RUN bundle config set --local path vendor/bundle \
  && bundle install --jobs 4

WORKDIR /app
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

# log/ and tmp/ are dockerignored — they are local-run scratch whose churn would
# invalidate the app COPY on every build — so recreate the empty trees Rails and
# Puma expect to already be there.
RUN mkdir -p log tmp/pids tmp/cache tmp/sockets \
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
