#!/usr/bin/env bash
#
# Build every gemspec to catch gemspec regressions (a broken gemspec once
# shipped unnoticed because nothing ever ran `gem build`).
#
# The release path still goes through tools/release/gem-release.mjs, which also
# asserts the three gem versions agree. This script is the CI smoke test only,
# so it needs Ruby alone and runs inside the same container as the test suites.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

for gemspec in packages/ruby/*/*.gemspec; do
  dir="$(dirname "$gemspec")"
  echo "building $(basename "$gemspec")"
  (cd "$dir" && gem build "$(basename "$gemspec")" --output /dev/null)
done
