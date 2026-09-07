#!/usr/bin/env bash
#
# The PHP engine suites plus the cross-language conformance harness.
#
# This is the single source of truth for "run the PHP tests": `npm run
# test:php` calls it for local development, and CI calls it inside a php
# container. It shells out to plain `php`/`composer` so the container needs
# PHP only — no Node.
#
# Packages are discovered by glob (packages/php/*/composer.json) and each
# package's PHPUnit suite runs from its own phpunit.xml; an empty glob, a
# package without tests, or a package whose test glob matches nothing is a hard
# failure so a moved suite directory cannot silently skip its tests.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

shopt -s nullglob

command -v php >/dev/null || { echo "php-tests.sh: php is not installed" >&2; exit 1; }
command -v composer >/dev/null || { echo "php-tests.sh: composer is not installed" >&2; exit 1; }

packages=(packages/php/*/composer.json)
if [ "${#packages[@]}" -eq 0 ]; then
  echo "php-tests.sh: no composer.json matched packages/php/*/composer.json" >&2
  exit 1
fi

for manifest in "${packages[@]}"; do
  dir="$(dirname "$manifest")"
  echo "== $dir"
  (cd "$dir" && composer validate --no-check-publish --no-interaction)
  if [ ! -f "$dir/vendor/autoload.php" ]; then
    (cd "$dir" && composer install --no-interaction --no-progress --prefer-dist)
  fi
  tests=("$dir"/tests/*Test.php "$dir"/tests/*/*Test.php)
  if [ "${#tests[@]}" -eq 0 ]; then
    echo "php-tests.sh: no test files matched $dir/tests/**/*Test.php" >&2
    exit 1
  fi
  (cd "$dir" && vendor/bin/phpunit)
done

# The cross-language conformance harness always runs last.
php tools/conformance/php-crosslang.php
