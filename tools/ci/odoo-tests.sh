#!/usr/bin/env bash
# The Odoo module's tests: the schema twin check in the library's environment,
# then the module's own tests in Odoo's official image (ODOO=19.0 by default,
# ODOO=20.0 for the newer series) against PostgreSQL. Shared by CI and
# `npm run test:odoo`.
set -euo pipefail

cd "$(dirname "$0")/../.."
ODOO="${ODOO:-19.0}"
docker_dir=packages/python/odoo/docker
project="or-odoo-test-${ODOO%%.*}"
compose=(docker compose -p "$project" -f "$docker_dir/compose.yml")

uv run --quiet --project packages/python/openreceive pytest -q -p no:cacheprovider packages/python/odoo/tests

rm -rf "$docker_dir/wheel"
(cd packages/python/openreceive && uv build --quiet --wheel --out-dir ../odoo/docker/wheel)
trap '"${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$docker_dir/wheel"' EXIT
ODOO="$ODOO" "${compose[@]}" build --quiet odoo

log=$(mktemp)
set +e
ODOO="$ODOO" "${compose[@]}" run --rm -T odoo odoo -d test \
  -i payment_openreceive --test-tags /payment_openreceive \
  --stop-after-init --no-http --log-level=test >"$log" 2>&1
status=$?
set -e
grep -v DeprecationWarning "$log" | grep -E 'odoo\.tests|payment_openreceive|ERROR|FAIL|Traceback' | tail -n 80
# Odoo's runner logs "0 failed, 0 error(s) of N tests" when the suite ran.
summary=$(grep -Eo '[0-9]+ failed, [0-9]+ error\(s\) of [0-9]+ tests' "$log" | tail -n 1)
if [ "$status" -ne 0 ] || [ -z "$summary" ] || ! [[ "$summary" =~ ^0\ failed,\ 0\ error ]] || [[ "$summary" =~ of\ 0\ tests ]]; then
  grep -v DeprecationWarning "$log" | grep -B2 -A25 'Traceback' | tail -n 150 >&2
  echo "Odoo $ODOO: the module's tests failed (${summary:-no test summary}, exit $status)." >&2
  exit 1
fi
echo "Odoo $ODOO: the module's tests passed ($summary)."
