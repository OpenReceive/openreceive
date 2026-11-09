#!/usr/bin/env bash
#
# Does OpenReceive install and actually run on Alpine (musl)?
#
# For each target it starts a throwaway container from the stock image, installs
# the packages built from THIS tree (trials/harness/tree-build.ts, at a version
# no registry has) the way a merchant's Dockerfile would, then runs a real app:
# create a checkout against the fake wallet, read it back, run doctor.
#
#   tools/ci/alpine-smoke.sh                    every target
#   tools/ci/alpine-smoke.sh ruby php           only these (node python php php-fpm ruby)
#
# Environment:
#   OPENRECEIVE_TREE_BUILD     reuse a tree build directory (holds manifest.json + out/)
#   OPENRECEIVE_SMOKE_PLATFORM e.g. linux/arm64; refused unless QEMU is registered
#   OPENRECEIVE_WALLET_URI_URL where the fake wallet publishes its code
#                              (default http://127.0.0.1:17890/uri)
#
# The wallet code travels only in the NWC_URI environment variable: it is never
# on a command line and never printed. Requires Docker, Node and the tools the
# tree build needs. Every container is named ortrial-alpine-* and removed.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

targets=("$@")
if [ "${#targets[@]}" -eq 0 ]; then
  targets=(node python php php-fpm ruby)
fi

platform="${OPENRECEIVE_SMOKE_PLATFORM:-}"
platform_args=()
if [ -n "$platform" ]; then
  if [ "$platform" != "linux/$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')" ] &&
    [ ! -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ]; then
    echo "OPENRECEIVE_SMOKE_PLATFORM=$platform needs QEMU registered on this host, and it is not." >&2
    exit 2
  fi
  platform_args=(--platform "$platform")
fi

build_dir="${OPENRECEIVE_TREE_BUILD:-}"
if [ -z "$build_dir" ]; then
  echo "== building packages from this tree"
  build_line="$(
    node --import tsx --input-type=module -e '
      const { ensureTreeBuild } = await import(`${process.cwd()}/trials/harness/tree-build.ts`);
      const build = await ensureTreeBuild(process.cwd());
      console.log(`TREE_BUILD_DIR=${build.directory}`);
    ' | tee /dev/stderr | grep '^TREE_BUILD_DIR='
  )"
  build_dir="${build_line#TREE_BUILD_DIR=}"
fi
if [ ! -f "$build_dir/manifest.json" ]; then
  echo "No tree build at $build_dir" >&2
  exit 2
fi

version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$build_dir/manifest.json")"

# Every OpenReceive tarball the Express quickstart's install pulls in, resolved
# from the manifests so a new internal dependency cannot go stale here.
npm_tarballs="$(
  node -e '
    const manifest = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const byName = new Map(manifest.npm.map((artifact) => [artifact.name, artifact]));
    const wanted = new Set(["@openreceive/express", "openreceive"]);
    for (const name of wanted) {
      const artifact = byName.get(name);
      if (artifact === undefined) throw new Error(`No tarball for ${name}`);
      for (const dep of Object.keys(artifact.manifest.dependencies ?? {})) {
        if (byName.has(dep)) wanted.add(dep);
      }
    }
    console.log([...wanted].map((name) => `/artifacts/${byName.get(name).file}`).join(" "));
  ' "$build_dir/manifest.json"
)"

wallet_url="${OPENRECEIVE_WALLET_URI_URL:-http://127.0.0.1:17890/uri}"
NWC_URI="$(curl -fsS "$wallet_url")"
export NWC_URI
if [ -z "$NWC_URI" ]; then
  echo "The fake wallet at $wallet_url returned no code." >&2
  exit 2
fi

smoke_dir="$(mktemp -d)"
current_container=""
cleanup() {
  if [ -n "$current_container" ]; then
    docker rm -f "$current_container" >/dev/null 2>&1 || true
  fi
  rm -rf "$smoke_dir"
}
trap cleanup EXIT

# --- shared by every target ---------------------------------------------------

cat >"$smoke_dir/drive.sh" <<'DRIVE'
# Sourced by each target. curl is only the test driver, added after the install.
add_driver() {
  command -v curl >/dev/null || apk add --no-cache curl >/dev/null
}

wait_for_server() {
  url="$1"
  log="$2"
  tries=0
  until curl -s -o /dev/null --max-time 5 "$url"; do
    tries=$((tries + 1))
    if [ "$tries" -gt 120 ]; then
      echo "server did not come up; log follows"
      cat "$log"
      return 1
    fi
    sleep 1
  done
}

# POST a checkout, then read that same attempt back.
checkout_and_read_back() {
  base="$1"
  reference="alpine-$(date +%s)"
  status="$(curl -s -o /tmp/create.json -w '%{http_code}' --max-time 120 -X POST \
    -H 'Content-Type: application/json' -d "{\"reference\":\"$reference\"}" "$base/checkouts")"
  echo "POST $base/checkouts -> $status"
  if [ "$status" != 201 ]; then
    head -c 800 /tmp/create.json
    echo
    return 1
  fi
  hash="$(sed -nE 's/.*"payment_hash":"([0-9a-f]{64})".*/\1/p' /tmp/create.json)"
  if [ -z "$hash" ]; then
    echo "no payment_hash in the response:"
    head -c 800 /tmp/create.json
    echo
    return 1
  fi
  echo "payment_hash ${hash%"${hash#????????}"}... invoice $(sed -nE 's/.*"(lnbc[a-z]*)[0-9a-z]*".*/\1/p' /tmp/create.json)"
  status="$(curl -s -o /tmp/check.json -w '%{http_code}' --max-time 120 -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"reference\":\"$reference\",\"payment_hash\":\"$hash\"}" "$base/payments/check")"
  echo "POST $base/payments/check -> $status: $(head -c 240 /tmp/check.json)"
  [ "$status" = 200 ] && grep -q '"status":"pending"' /tmp/check.json
  echo "== [runtime] checkout created and read back"
}
DRIVE

# --- node ---------------------------------------------------------------------

cat >"$smoke_dir/node.sh" <<'NODE'
set -eu
. /smoke/drive.sh
echo "== [install] npm install, no system packages added"
mkdir -p /app && cd /app
npm init -y >/dev/null
# shellcheck disable=SC2086
npm install --no-audit --no-fund --loglevel=error $OR_NPM_TARBALLS express
echo "compiled addons in node_modules (expect none): $(find node_modules -name '*.node' | wc -l)"

cat >server.mjs <<'EOF'
import { DatabaseSync } from "node:sqlite";
import { openReceiveExpress } from "@openreceive/express";
import { paymentsSchemaSql } from "@openreceive/http";
import express from "express";

const db = new DatabaseSync("/app/shop.db");
db.exec(paymentsSchemaSql("sqlite"));
const app = express();
app.use(express.json());
app.use(
  openReceiveExpress({
    wallet: { nwc: process.env.NWC_URI },
    storage: { db, onPaid: async () => {} },
    amountFor: async () => ({ sats: 5000, description: "alpine smoke" }),
    authorize: async () => true,
  }),
);
app.listen(3000, "127.0.0.1");
EOF

echo "== [runtime] start the Express app"
add_driver
node server.mjs >server.log 2>&1 &
wait_for_server http://127.0.0.1:3000/ server.log
checkout_and_read_back http://127.0.0.1:3000/openreceive
echo "== [doctor] npx openreceive doctor"
npx --no-install openreceive doctor --db /app/shop.db --url http://127.0.0.1:3000
NODE

# --- python -------------------------------------------------------------------

cat >"$smoke_dir/python.sh" <<'PYTHON'
set -eu
. /smoke/drive.sh
echo "== [install] pip install, no system packages added"
python -m venv /venv
. /venv/bin/activate
pip install --quiet --no-cache-dir "/artifacts/python/openreceive-${OR_VERSION}-py3-none-any.whl[fastapi]" uvicorn
pip list 2>/dev/null | grep -iE '^(openreceive|coincurve|cryptography|websockets|cffi) '
# This image has no compiler, so a dependency without a musl wheel fails above.
echo "compiler in this image: $(command -v gcc || echo none)"
grep -h '^Tag: ' /venv/lib/python*/site-packages/coincurve-*.dist-info/WHEEL \
  /venv/lib/python*/site-packages/cryptography-*.dist-info/WHEEL \
  /venv/lib/python*/site-packages/cffi-*.dist-info/WHEEL \
  /venv/lib/python*/site-packages/websockets-*.dist-info/WHEEL

mkdir -p /app && cd /app
openreceive scaffold payments --sql --dialect sqlite >schema.sql
python - <<'EOF'
import sqlite3
sqlite3.connect("/app/shop.db").executescript(open("/app/schema.sql").read())
EOF

cat >main.py <<'EOF'
from fastapi import FastAPI
from sqlalchemy import create_engine

from openreceive.fastapi import openreceive_lifespan, openreceive_router
from openreceive.server import Host

engine = create_engine("sqlite:////app/shop.db")
host = Host(
    amount_for=lambda reference: {"sats": 5000, "description": "alpine smoke"},
    authorize=lambda context: True,
    on_paid=lambda settlement: None,
)
router = openreceive_router(host, engine=engine)
app = FastAPI(lifespan=openreceive_lifespan(host, engine=engine))
app.include_router(router, prefix="/openreceive")
EOF

echo "== [runtime] start the FastAPI app"
add_driver
uvicorn main:app --host 127.0.0.1 --port 3000 --log-level warning >server.log 2>&1 &
wait_for_server http://127.0.0.1:3000/ server.log
checkout_and_read_back http://127.0.0.1:3000/openreceive
echo "== [doctor] openreceive doctor --app main:app"
openreceive doctor --app main:app --url http://127.0.0.1:3000
PYTHON

# --- php ----------------------------------------------------------------------

cat >"$smoke_dir/php.sh" <<'PHP'
set -eu
. /smoke/drive.sh
echo "== [install] the Alpine GMP recipe from quickstart-woocommerce.md"
apk add --no-cache gmp >/dev/null
# shellcheck disable=SC2086
apk add --no-cache --virtual .gmp-build $PHPIZE_DEPS gmp-dev >/dev/null
docker-php-ext-install gmp >/tmp/gmp.log 2>&1 || { tail -30 /tmp/gmp.log; exit 1; }
apk del .gmp-build >/dev/null
for ext in gmp sodium mbstring PDO pdo_sqlite json; do
  php -m | grep -qix "$ext" || { echo "missing extension: $ext"; exit 1; }
done
echo "extensions present: gmp sodium mbstring PDO pdo_sqlite json"
echo "PHP_INT_SIZE=$(php -r 'echo PHP_INT_SIZE;')"

echo "== [install] composer require, from the packed zip"
curl -fsS https://getcomposer.org/installer | php -- --quiet --install-dir=/usr/local/bin --filename=composer
mkdir -p /pkg /app/public /app/bin
cd /pkg
unzip -q "/artifacts/composer/openreceive-${OR_VERSION}.zip"
cd /app
cat >composer.json <<EOF
{
  "repositories": [
    {
      "type": "path",
      "url": "/pkg",
      "options": { "symlink": false, "versions": { "openreceive/openreceive": "${OR_VERSION}" } }
    }
  ]
}
EOF
composer require --no-interaction --no-progress --quiet \
  "openreceive/openreceive:${OR_VERSION}" nyholm/psr7 nyholm/psr7-server
composer show --quiet openreceive/openreceive
echo "compiled files in vendor (expect none): $(find vendor -name '*.so' | wc -l)"

cat >host.php <<'EOF'
<?php
declare(strict_types=1);

use OpenReceive\Host;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\AuthorizeContext;

return new class implements Host {
    public function authorize(AuthorizeContext $context): bool { return true; }
    public function amountFor(string $reference): ?array { return ['sats' => 5000, 'description' => 'alpine smoke']; }
    public function onPaid(PaymentSettlement $settlement): void {}
};
EOF

cat >bin/migrate.php <<'EOF'
<?php
declare(strict_types=1);

use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;

require dirname(__DIR__) . '/vendor/autoload.php';
PaymentsSchema::migrate(new PdoConnection(new PDO('sqlite:/app/shop.db')));
EOF

cat >public/index.php <<'EOF'
<?php
declare(strict_types=1);

use Nyholm\Psr7\Factory\Psr17Factory;
use Nyholm\Psr7Server\ServerRequestCreator;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;

require dirname(__DIR__) . '/vendor/autoload.php';

$engine = new Engine(
    require dirname(__DIR__) . '/host.php',
    new SqlPaymentRepository(new PdoConnection(new PDO('sqlite:/app/shop.db'))),
    Service::fromEnvironment(),
    prefix: '/openreceive',
);
$factory = new Psr17Factory();
$request = (new ServerRequestCreator($factory, $factory, $factory, $factory))->fromGlobals();
$response = $engine->psr15Handler()->handle($request);
http_response_code($response->getStatusCode());
foreach ($response->getHeaders() as $name => $values) {
    foreach ($values as $value) {
        header("{$name}: {$value}", false);
    }
}
echo $response->getBody();
EOF

cat >bin/doctor.php <<'EOF'
<?php
declare(strict_types=1);

use OpenReceive\Server\Doctor;
use OpenReceive\Server\Service;

require dirname(__DIR__) . '/vendor/autoload.php';

$env = Service::processEnvironment();
$host = require dirname(__DIR__) . '/host.php';
foreach (Doctor::report($env, $host, static fn () => Service::fromEnvironment($env), '/openreceive') as $line) {
    echo $line, PHP_EOL;
}
EOF

php bin/migrate.php
chown -R www-data:www-data /app

if [ "$OR_PHP_SAPI" = fpm ]; then
  echo "== [runtime] php-fpm"
  apk add --no-cache fcgi >/dev/null
  # The stock pool: the official image already sets clear_env = no and listens on 9000.
  php-fpm -D
  add_driver
  # A curl-shaped wrapper: cgi-fcgi prints the CGI response, headers then body.
  fcgi_post() {
    uri="$1"
    body="$2"
    output="$3"
    printf '%s' "$body" |
      REQUEST_METHOD=POST REQUEST_URI="$uri" SCRIPT_NAME=/index.php SCRIPT_FILENAME=/app/public/index.php \
        CONTENT_TYPE=application/json CONTENT_LENGTH="${#body}" SERVER_PROTOCOL=HTTP/1.1 \
        cgi-fcgi -bind -connect 127.0.0.1:9000 >/tmp/fcgi.out
    sed -n '1,/^\r*$/p' /tmp/fcgi.out >/tmp/fcgi.head
    sed '1,/^\r*$/d' /tmp/fcgi.out >"$output"
    sed -nE 's/^Status: ([0-9]+).*/\1/p' /tmp/fcgi.head
  }
  tries=0
  until cgi-fcgi -bind -connect 127.0.0.1:9000 </dev/null >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 30 ] || { echo "php-fpm did not come up"; exit 1; }
    sleep 1
  done
  reference="alpine-$(date +%s)"
  status="$(fcgi_post /openreceive/checkouts "{\"reference\":\"$reference\"}" /tmp/create.json)"
  echo "POST /openreceive/checkouts (FastCGI) -> ${status:-200}"
  if [ "${status:-}" != 201 ]; then head -c 800 /tmp/create.json; echo; exit 1; fi
  hash="$(sed -nE 's/.*"payment_hash":"([0-9a-f]{64})".*/\1/p' /tmp/create.json)"
  status="$(fcgi_post /openreceive/payments/check "{\"reference\":\"$reference\",\"payment_hash\":\"$hash\"}" /tmp/check.json)"
  echo "POST /openreceive/payments/check (FastCGI) -> ${status:-200}: $(head -c 240 /tmp/check.json)"
  [ "${status:-200}" = 200 ] && grep -q '"status":"pending"' /tmp/check.json
  echo "== [runtime] checkout created and read back"
else
  echo "== [runtime] php built-in server"
  add_driver
  php -S 127.0.0.1:3000 -t public public/index.php >server.log 2>&1 &
  wait_for_server http://127.0.0.1:3000/ server.log
  checkout_and_read_back http://127.0.0.1:3000/openreceive
fi

echo "== [doctor] bin/doctor.php"
php bin/doctor.php
PHP

# --- ruby ---------------------------------------------------------------------

cat >"$smoke_dir/ruby.sh" <<'RUBY'
set -eu
. /smoke/drive.sh
# The Alpine names for the Debian packages in quickstart-rails.md / deploying.md,
# plus tzdata: Alpine ships no zoneinfo and Rails (tzinfo) will not boot without it.
OR_APK="build-base autoconf automake libtool pkgconf openssl-dev tzdata"
echo "== [install] apk add $OR_APK"
# shellcheck disable=SC2086
apk add --no-cache $OR_APK >/dev/null

echo "== [install] rails new, then the packed gems plus bundle install"
gem install --no-document --quiet rails
gem install --no-document --quiet --local --ignore-dependencies \
  "/artifacts/gems/openreceive-${OR_VERSION}.gem" \
  "/artifacts/gems/openreceive-server-${OR_VERSION}.gem" \
  "/artifacts/gems/openreceive-rails-${OR_VERSION}.gem"
rails new /app --minimal --database=sqlite3 --skip-git --skip-docker --skip-bootsnap \
  --skip-keeps --skip-test --skip-kamal --skip-thruster --skip-ci --skip-rubocop \
  --skip-brakeman --quiet
cd /app
echo "gem \"openreceive-rails\", \"${OR_VERSION}\"" >>Gemfile
bundle install --quiet
echo "native extensions built:"
find /usr/local/bundle/extensions -name gem_make.out | sed -E 's#.*/([^/]+)/gem_make.out#  \1#' | sort

bin/rails generate openreceive:install
cat >config/initializers/zz_openreceive_smoke.rb <<'EOF'
OpenReceive.configure do |config|
  config.amount_for = ->(_reference) { { sats: 5000, description: "alpine smoke" } }
end
# curl carries no CSRF token; a real page sends the meta tag's token.
Rails.application.config.action_controller.allow_forgery_protection = false
EOF
bin/rails db:migrate >/dev/null

echo "== [runtime] start the Rails app"
add_driver
bin/rails server -b 127.0.0.1 -p 3000 >server.log 2>&1 &
wait_for_server http://127.0.0.1:3000/up server.log
checkout_and_read_back http://127.0.0.1:3000/openreceive
echo "== [doctor] bin/rails openreceive:doctor"
bin/rails openreceive:doctor
RUBY

# --- run ----------------------------------------------------------------------

run_target() {
  local target="$1"
  local image script
  local env_args=(-e NWC_URI -e "OR_VERSION=$version")
  case "$target" in
    node)
      image=node:22-alpine
      script=node.sh
      env_args+=(-e "OR_NPM_TARBALLS=$npm_tarballs")
      ;;
    python)
      image=python:3.12-alpine
      script=python.sh
      ;;
    php)
      image=php:8.3-cli-alpine
      script=php.sh
      env_args+=(-e OR_PHP_SAPI=cli)
      ;;
    php-fpm)
      image=php:8.3-fpm-alpine
      script=php.sh
      env_args+=(-e OR_PHP_SAPI=fpm)
      ;;
    ruby)
      image=ruby:3.4-alpine
      script=ruby.sh
      ;;
    *)
      echo "Unknown target: $target (node python php php-fpm ruby)" >&2
      return 2
      ;;
  esac
  current_container="ortrial-alpine-$target-$$"
  echo
  echo "===== $target on $image ${platform:+($platform) }====="
  docker run --rm --name "$current_container" "${platform_args[@]}" \
    "${env_args[@]}" \
    -v "$build_dir/out:/artifacts:ro" \
    -v "$smoke_dir:/smoke:ro" \
    "$image" sh /smoke/"$script" 2>&1 | sed -u -E 's/([?&]secret=)[0-9a-fA-F]+/\1REDACTED/g'
  local status="${PIPESTATUS[0]}"
  current_container=""
  return "$status"
}

failed=0
summary=""
for target in "${targets[@]}"; do
  if run_target "$target"; then
    summary+="PASS  $target"$'\n'
  else
    summary+="FAIL  $target"$'\n'
    failed=1
  fi
done

echo
echo "===== summary (tree build $build_dir, version $version) ====="
printf '%s' "$summary"
exit "$failed"
