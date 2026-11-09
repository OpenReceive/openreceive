#!/usr/bin/env bash
#
# Two deployment edge cases no ordinary lane covers, run against throwaway
# databases this script starts itself (containers named ortrial-edge-*):
#
#   1. Two instances of one shop behind a load balancer: two real app
#      processes per engine on one Postgres / MySQL and one fake wallet
#      (tests/deployment/two-instances.test.mjs).
#   2. A database not set to UTC: Postgres with timezone=Asia/Tokyo, MySQL with
#      --default-time-zone=+09:00, the host process in another zone again,
#      running the engines' own storage suites plus focused boundary tests.
#
#   tools/ci/deployment-edge-tests.sh            # both cases, Tokyo databases
#   EDGE_DB_ZONE=utc tools/ci/deployment-edge-tests.sh two-instances
#                                                # case 1 on default-UTC databases
#   tools/ci/deployment-edge-tests.sh non-utc    # case 2 only
#
# Needs Docker, node (repo root deps installed), packages/python/openreceive/.venv
# (uv sync) and packages/php/openreceive/vendor (composer install); PHP and Ruby
# run in images built from the docker build snippets below. Set EDGE_ENGINES
# (default node,python,php,rails) to narrow case 1.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO="$PWD"

MODE="${1:-all}"
ZONE="${EDGE_DB_ZONE:-tokyo}"
PG_PORT="${EDGE_PG_PORT:-59471}"
MYSQL_PORT="${EDGE_MYSQL_PORT:-59472}"
PG_NAME="ortrial-edge-pg-${ZONE}"
MYSQL_NAME="ortrial-edge-mysql-${ZONE}"
PHP_IMAGE="${EDGE_PHP_IMAGE:-ortrial-edge-php}"
RUBY_IMAGE="${EDGE_RUBY_IMAGE:-ortrial-edge-ruby}"
HOST_TZ="America/New_York"

declare -a FAILED=()

cleanup() {
  docker rm -f "$PG_NAME" "$MYSQL_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

note() { printf '\n== %s\n' "$*"; }

run() {
  local name="$1"
  shift
  note "$name"
  if ! "$@"; then
    FAILED+=("$name")
  fi
}

build_images() {
  docker image inspect "$PHP_IMAGE" >/dev/null 2>&1 || docker build -q -t "$PHP_IMAGE" - >/dev/null <<'DOCKERFILE'
FROM php:8.3-cli-alpine
RUN apk add --no-cache postgresql-dev gmp-dev bash git unzip $PHPIZE_DEPS linux-headers libsodium-dev oniguruma-dev \
 && docker-php-ext-install -j8 pdo_pgsql pdo_mysql gmp bcmath sodium mbstring pcntl sockets >/dev/null
DOCKERFILE
  docker image inspect "$RUBY_IMAGE" >/dev/null 2>&1 || docker build -q -t "$RUBY_IMAGE" - >/dev/null <<'DOCKERFILE'
FROM ruby:3.4
ENV BUNDLE_SILENCE_ROOT_WARNING=1
RUN gem install --no-document rails -v '~> 8.0' >/dev/null && gem install --no-document sqlite3 pg mysql2 puma rackup minitest >/dev/null && gem install --no-document nwc-ruby -v '~> 0.5' >/dev/null
DOCKERFILE
}

start_databases() {
  local pg_args=() mysql_args=()
  if [ "$ZONE" = "tokyo" ]; then
    pg_args=(-c timezone=Asia/Tokyo)
    mysql_args=(--default-time-zone=+09:00)
  fi
  docker rm -f "$PG_NAME" "$MYSQL_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$PG_NAME" -e POSTGRES_USER=openreceive -e POSTGRES_PASSWORD=openreceive \
    -e POSTGRES_DB=openreceive_test -p "127.0.0.1:${PG_PORT}:5432" postgres:18-alpine \
    -c max_connections=200 "${pg_args[@]}" >/dev/null
  docker run -d --name "$MYSQL_NAME" -e MYSQL_ROOT_PASSWORD=openreceive -e MYSQL_DATABASE=openreceive_test \
    -p "127.0.0.1:${MYSQL_PORT}:3306" mysql:8.4 --max-connections=300 "${mysql_args[@]}" >/dev/null
  for _ in $(seq 1 120); do
    if docker exec "$PG_NAME" pg_isready -U openreceive -d openreceive_test >/dev/null 2>&1 &&
      docker exec "$MYSQL_NAME" mysqladmin ping -h127.0.0.1 -popenreceive --silent >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  docker exec "$PG_NAME" psql -U openreceive -d openreceive_test -Atc \
    "select 'postgres session zone: ' || current_setting('TimeZone') || ', now() ' || now()"
  docker exec "$MYSQL_NAME" sh -c "exec mysql -uroot -popenreceive -Ne \"select concat('mysql session zone: ', @@session.time_zone, ', now() ', now())\" 2>/dev/null"
}

export OPENRECEIVE_TEST_POSTGRES_URL="postgresql://openreceive:openreceive@127.0.0.1:${PG_PORT}/openreceive_test"
export OPENRECEIVE_TEST_MYSQL_URL_NODE="mysql://root:openreceive@127.0.0.1:${MYSQL_PORT}/openreceive_test"

NODE=(node --import tsx)
PYTHON="packages/python/openreceive/.venv/bin"

node_two_instances() {
  OPENRECEIVE_TEST_MYSQL_URL="$OPENRECEIVE_TEST_MYSQL_URL_NODE" \
    EDGE_ENGINES="${EDGE_ENGINES:-node,python,php,rails}" TZ="$HOST_TZ" \
    "${NODE[@]}" --test --test-concurrency=1 --test-reporter=spec tests/deployment/two-instances.test.mjs
}

node_non_utc() {
  OPENRECEIVE_TEST_MYSQL_URL="$OPENRECEIVE_TEST_MYSQL_URL_NODE" TZ="$HOST_TZ" \
    "${NODE[@]}" --test --test-reporter=spec tests/deployment/non-utc.test.mjs
}

node_orm_lanes() {
  npx --no-install prisma generate --schema tests/orms/mysql/schema.prisma >/dev/null || return 1
  OPENRECEIVE_TEST_MYSQL_URL="$OPENRECEIVE_TEST_MYSQL_URL_NODE" TZ="$HOST_TZ" \
    "${NODE[@]}" --test --test-reporter=spec tests/orms/knex-postgres.test.mjs tests/orms/mysql.test.mjs
}

python_storage() {
  OPENRECEIVE_TEST_PGSQL_URL="postgresql+psycopg://openreceive:openreceive@127.0.0.1:${PG_PORT}/openreceive_test" \
    OPENRECEIVE_TEST_MYSQL_URL="mysql+pymysql://root:openreceive@127.0.0.1:${MYSQL_PORT}/openreceive_test" TZ="$HOST_TZ" \
    "$PYTHON/pytest" packages/python/openreceive/tests/storage -q --no-header
}

python_django() {
  (cd packages/python/openreceive &&
    OPENRECEIVE_TEST_PGSQL_URL="postgresql://openreceive:openreceive@127.0.0.1:${PG_PORT}/openreceive_test" TZ="$HOST_TZ" \
      .venv/bin/pytest tests/django -q --no-header)
}

php_suite() {
  docker run --rm --name "ortrial-edge-phpunit-$$" --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -e OPENRECEIVE_TEST_PGSQL_DSN="pgsql:host=127.0.0.1;port=${PG_PORT};dbname=openreceive_test" \
    -e OPENRECEIVE_TEST_PGSQL_USER=openreceive -e OPENRECEIVE_TEST_PGSQL_PASSWORD=openreceive \
    -e OPENRECEIVE_TEST_MYSQL_DSN="mysql:host=127.0.0.1;port=${MYSQL_PORT};dbname=openreceive_test" \
    -e OPENRECEIVE_TEST_MYSQL_USER=root -e OPENRECEIVE_TEST_MYSQL_PASSWORD=openreceive \
    -v "$REPO:/repo:ro" -w /repo/packages/php/openreceive "$PHP_IMAGE" \
    php -d "date.timezone=$HOST_TZ" vendor/bin/phpunit --do-not-cache-result --no-progress
}

rails_suites() {
  docker run --rm --name "ortrial-edge-rubytest-$$" --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -e TZ="$HOST_TZ" \
    -e OPENRECEIVE_TEST_PGSQL_URL="postgresql://openreceive:openreceive@127.0.0.1:${PG_PORT}/openreceive_test" \
    -e OPENRECEIVE_TEST_MYSQL_URL="mysql://root:openreceive@127.0.0.1:${MYSQL_PORT}/openreceive_test" \
    -v "$REPO:/repo:ro" -w /repo "$RUBY_IMAGE" \
    bash -c 'for test in non_utc_database repository_dialects rails; do
      ruby -Ipackages/ruby/openreceive/lib -Ipackages/ruby/openreceive-server/lib -Ipackages/ruby/openreceive-rails/lib \
        "packages/ruby/openreceive-rails/test/${test}_test.rb" | grep -v "unknown OID" | tail -3 || exit 1
    done'
}

build_images
start_databases

case "$MODE" in
  two-instances)
    run "two instances per engine (Postgres, MySQL; ${ZONE})" node_two_instances
    ;;
  non-utc)
    run "Node: non-UTC boundaries" node_non_utc
    run "Node: Postgres and MySQL repository lanes" node_orm_lanes
    run "Python: storage suite plus non-UTC boundaries" python_storage
    run "Python: Django suite" python_django
    run "PHP: engine suite plus non-UTC boundaries" php_suite
    run "Rails: non-UTC boundaries, dialects, model suite" rails_suites
    ;;
  all)
    run "two instances per engine (Postgres, MySQL; ${ZONE})" node_two_instances
    run "Node: non-UTC boundaries" node_non_utc
    run "Node: Postgres and MySQL repository lanes" node_orm_lanes
    run "Python: storage suite plus non-UTC boundaries" python_storage
    run "Python: Django suite" python_django
    run "PHP: engine suite plus non-UTC boundaries" php_suite
    run "Rails: non-UTC boundaries, dialects, model suite" rails_suites
    ;;
  *)
    echo "deployment-edge-tests.sh: unknown mode '$MODE' (all, two-instances, non-utc)" >&2
    exit 2
    ;;
esac

if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '\nFAILED:\n'
  printf ' - %s\n' "${FAILED[@]}"
  exit 1
fi
printf '\nAll lanes passed.\n'
