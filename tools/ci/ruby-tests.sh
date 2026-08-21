#!/usr/bin/env bash
#
# The Ruby engine suites plus the cross-language conformance harness.
#
# This is the single source of truth for "run the Ruby tests": `npm run
# test:ruby` calls it for local development, and CI calls it under `bundle
# exec` inside a ruby container. It deliberately shells out to plain `ruby`
# rather than npm so the CI container needs Ruby only — no Node, and no gems
# installed on the runner host.
#
# Test files are discovered by glob (sorted by bash's glob expansion) so a new
# *_test.rb file runs without editing this script; an empty glob is a hard
# failure so a moved suite directory cannot silently skip its tests.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

CORE=packages/ruby/openreceive/lib
SERVER=packages/ruby/openreceive-server/lib
RAILS=packages/ruby/openreceive-rails/lib

shopt -s nullglob

# assert_nonempty <count> <suite-dir> -- fails when a suite glob matched nothing.
assert_nonempty() {
  if [ "$1" -eq 0 ]; then
    echo "ruby-tests.sh: no test files matched $2/*_test.rb" >&2
    exit 1
  fi
}

core_tests=(packages/ruby/openreceive/test/*_test.rb)
assert_nonempty "${#core_tests[@]}" packages/ruby/openreceive/test
for file in "${core_tests[@]}"; do
  if [ "$(basename "$file")" = "openreceive_test.rb" ]; then
    # openreceive_test.rb is `load`ed because its filename collides with the
    # `openreceive` library it requires.
    ruby -I"$CORE" -e "load \"$file\""
  else
    ruby -I"$CORE" "$file"
  fi
done

server_tests=(packages/ruby/openreceive-server/test/*_test.rb)
assert_nonempty "${#server_tests[@]}" packages/ruby/openreceive-server/test
for file in "${server_tests[@]}"; do
  ruby -I"$CORE" -I"$SERVER" "$file"
done

rails_tests=(packages/ruby/openreceive-rails/test/*_test.rb)
assert_nonempty "${#rails_tests[@]}" packages/ruby/openreceive-rails/test
for file in "${rails_tests[@]}"; do
  ruby -I"$CORE" -I"$SERVER" -I"$RAILS" "$file"
done

# The cross-language conformance harness always runs last.
ruby -I"$CORE" -I"$SERVER" tools/conformance/ruby-crosslang.rb
