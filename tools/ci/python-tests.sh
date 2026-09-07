#!/usr/bin/env bash
#
# The Python engine suite plus the cross-language conformance harness.
#
# This is the single source of truth for "run the Python tests": `npm run
# test:python` calls it for local development, and CI calls it inside the
# python-engine job. It runs through `uv` (the project's own environment under
# packages/python/openreceive) so the CI runner needs uv only — no Node, no
# system Python.
#
# Test files are discovered by glob so a new test_*.py file runs without
# editing this script; an empty glob is a hard failure so a moved suite
# directory cannot silently skip its tests. Set OPENRECEIVE_TEST_PGSQL_URL /
# OPENRECEIVE_TEST_MYSQL_URL to also run the repository suite against those
# databases (the lock paths); SQLite always runs.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

PACKAGE=packages/python/openreceive

if ! command -v uv >/dev/null 2>&1; then
  echo "python-tests.sh: uv is required (https://docs.astral.sh/uv/)" >&2
  exit 1
fi

# assert_nonempty <count> <suite-dir> -- fails when a suite glob matched nothing.
# (`find`, not bash globstar: macOS ships bash 3.2, which has no globstar.)
assert_nonempty() {
  if [ "$1" -eq 0 ]; then
    echo "python-tests.sh: no test files matched $2/**/test_*.py" >&2
    exit 1
  fi
}

package_test_count=$(find "$PACKAGE/tests" -type f -name 'test_*.py' -not -path '*/.venv/*' | wc -l | tr -d ' ')
assert_nonempty "$package_test_count" "$PACKAGE/tests"

# One environment for the whole run: the dev group carries pytest, sqlalchemy,
# ruff and mypy; `--frozen` refuses to drift from the committed uv.lock.
# Rebuild the editable package so its hook refreshes Django's standalone
# checkout copy after build:packages, even when Python sources did not change.
uv sync --project "$PACKAGE" --frozen --reinstall-package openreceive --quiet

if [ -n "${OPENRECEIVE_TEST_DJANGO:-}" ]; then
  uv pip install --python "$PACKAGE/.venv/bin/python" "Django==${OPENRECEIVE_TEST_DJANGO}"
fi
uv run --project "$PACKAGE" --frozen --no-sync pytest "$PACKAGE/tests" -q

# The cross-language conformance harness always runs last.
uv run --project "$PACKAGE" --frozen --no-sync python tools/conformance/python-crosslang.py
