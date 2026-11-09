#!/usr/bin/env bash
# Starts one PHP instance for tests/deployment/two-instances.test.mjs: `php -S`
# with several workers, so requests really do run in separate processes.
set -euo pipefail
cd /repo
if [ "${1:-}" = "migrate" ]; then
  exec php tests/deployment/instances/php-instance.php migrate
fi
export PHP_CLI_SERVER_WORKERS="${EDGE_PHP_WORKERS:-8}"
exec php -S "127.0.0.1:${EDGE_PORT}" tests/deployment/instances/php-instance.php
