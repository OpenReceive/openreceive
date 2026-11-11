#!/usr/bin/env bash
#
# nuxt-openreceive, a Nuxt module someone else maintains, built and tested
# against THIS tree's packages: the downstream check for what our own suites
# cannot see (a consumer's build, its patches over our files, its SSR).
#
#   bash tools/ci/downstream-nuxt.sh              # the pinned commit below
#   NUXT_OPENRECEIVE_REF=<sha> bash tools/ci/downstream-nuxt.sh
#
# It packs @openreceive/{core,provider-data,browser,elements,vue,node,http}
# from this checkout (build them first: npm run build:packages), clones the
# module at NUXT_OPENRECEIVE_REF inside a node:22 container, points every
# @openreceive/* dependency at those tarballs, and runs the module's own CI:
# install, prepare, its Checkout.js patch, build, typecheck, and its tests
# against a throwaway Postgres on the module's in-memory test wallet. The
# playground then serves its checkout page with the routes moved to /pay, and
# a real Chromium must see one prepare under /pay and a clean console (#132,
# #137).
#
# The module's code runs only inside the container, which gets no secrets and
# no checkout of ours beyond the tarballs. Bump the pin on purpose, after
# reading what changed upstream.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

REPO_URL="https://github.com/aisoul-dev/nuxt-openreceive.git"
REF="${NUXT_OPENRECEIVE_REF:-ba3a193d18c9c3dee36b2535da41bb6147973b7b}"
NODE_IMAGE="${DOWNSTREAM_NODE_IMAGE:-node:22-bookworm}"
PORT="${DOWNSTREAM_NUXT_PORT:-3912}"
RUN_ID="openreceive-downstream-nuxt-$$"
WORK="$(mktemp -d)"
PG_NAME="${RUN_ID}-pg"
NET_NAME="${RUN_ID}-net"
APP_NAME="${RUN_ID}-app"

cleanup() {
  docker rm -f "$APP_NAME" "$PG_NAME" >/dev/null 2>&1 || true
  docker network rm "$NET_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== pack this tree's packages"
mkdir -p "$WORK/tarballs"
for pkg in core provider-data browser elements vue node http; do
  test -d "packages/js/$pkg/dist" || {
    echo "packages/js/$pkg/dist is missing: run npm run build:packages first" >&2
    exit 1
  }
  npm pack --silent --ignore-scripts --pack-destination "$WORK/tarballs" -w "@openreceive/$pkg" >/dev/null
done
ls "$WORK/tarballs"

echo "== throwaway Postgres"
docker network create "$NET_NAME" >/dev/null
docker run -d --name "$PG_NAME" --network "$NET_NAME" -e POSTGRES_USER=nuxt -e POSTGRES_PASSWORD=nuxt \
  -e POSTGRES_DB=nuxt postgres:18-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$PG_NAME" pg_isready -U nuxt >/dev/null 2>&1 && break
  sleep 1
done

echo "== nuxt-openreceive@${REF:0:12}: install, prepare, patch, build, typecheck, test"
docker run --name "$APP_NAME" -d --network "$NET_NAME" -p "127.0.0.1:${PORT}:${PORT}" \
  -e DATABASE_URL="postgres://nuxt:nuxt@${PG_NAME}:5432/nuxt" -e PORT="$PORT" -e REF="$REF" -e REPO_URL="$REPO_URL" \
  -e CI=1 -e NUXT_TELEMETRY_DISABLED=1 \
  -v "$WORK/tarballs:/tarballs:ro" -w /work "$NODE_IMAGE" bash -euo pipefail -c '
    corepack enable >/dev/null 2>&1
    git clone -q "$REPO_URL" module && cd module && git checkout -q "$REF"
    # Every @openreceive/* dependency, direct or not, from this tree.
    node -e "
      const fs = require(\"node:fs\");
      const pkg = JSON.parse(fs.readFileSync(\"package.json\", \"utf8\"));
      const overrides = {};
      for (const file of fs.readdirSync(\"/tarballs\")) {
        const name = \"@openreceive/\" + file.replace(/^openreceive-/, \"\").replace(/-\\d.*$/, \"\");
        overrides[name] = \"file:/tarballs/\" + file;
      }
      for (const name of Object.keys(pkg.dependencies)) {
        if (overrides[name]) pkg.dependencies[name] = overrides[name];
      }
      pkg.pnpm = { ...(pkg.pnpm ?? {}), overrides: { ...(pkg.pnpm?.overrides ?? {}), ...overrides } };
      fs.writeFileSync(\"package.json\", JSON.stringify(pkg, null, 2));
    "
    pnpm install --no-frozen-lockfile --reporter=silent
    pnpm dev:prepare
    pnpm compile:checkout
    grep -q "\^\^" src/runtime/components/checkout.generated.js && { echo "the module patch double-forced an attribute (^^)" >&2; exit 1; }
    pnpm build
    pnpm typecheck
    pnpm test
    # The playground with its routes away from the default, served for the browser check.
    sed -i "s#migrate: true,#migrate: true,\n    prefix: \"/pay\",#" playground/nuxt.config.ts
    npx nuxi build playground > /dev/null
    echo "PLAYGROUND READY"
    OPENRECEIVE_TEST_WALLET=1 HOST=0.0.0.0 exec node playground/.output/server/index.mjs
  ' >/dev/null

for _ in $(seq 1 600); do
  if docker logs "$APP_NAME" 2>&1 | grep -q "PLAYGROUND READY"; then break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$APP_NAME")" != "true" ]; then
    docker logs "$APP_NAME" 2>&1 | tail -60
    echo "downstream-nuxt: the module's CI failed" >&2
    exit 1
  fi
  sleep 2
done
docker logs "$APP_NAME" 2>&1 | grep -E "^# (tests|pass|fail|skipped)" || true

echo "== the playground's checkout page in Chromium"
node --import tsx tools/ci/downstream-nuxt-browser.mjs "http://127.0.0.1:${PORT}"
echo "downstream-nuxt: ok"
