#!/usr/bin/env bash
#
# The Ruby engine suites plus the cross-language conformance harness.
#
# This is the single source of truth for "run the Ruby tests": `npm run
# test:ruby` calls it for local development, and CI calls it under `bundle
# exec` inside a ruby container. It deliberately shells out to plain `ruby`
# rather than npm so the CI container needs Ruby only — no Node, and no gems
# installed on the runner host.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

CORE=packages/ruby/openreceive/lib
SERVER=packages/ruby/openreceive-server/lib
RAILS=packages/ruby/openreceive-rails/lib

# openreceive_test.rb is `load`ed because its filename collides with the
# `openreceive` library it requires.
ruby -I"$CORE" -e 'load "packages/ruby/openreceive/test/openreceive_test.rb"'
ruby -I"$CORE" packages/ruby/openreceive/test/nwc_ruby_test.rb
ruby -I"$CORE" packages/ruby/openreceive/test/rates_test.rb
ruby -I"$CORE" packages/ruby/openreceive/test/swap_address_test.rb
ruby -I"$CORE" -I"$SERVER" packages/ruby/openreceive-server/test/swap_test.rb
ruby -I"$CORE" -I"$SERVER" packages/ruby/openreceive-server/test/server_test.rb
ruby -I"$CORE" -I"$SERVER" packages/ruby/openreceive-server/test/preflight_adapter_test.rb
ruby -I"$CORE" -I"$SERVER" packages/ruby/openreceive-server/test/fixedfloat_test.rb
ruby -I"$CORE" -I"$SERVER" -I"$RAILS" packages/ruby/openreceive-rails/test/rails_test.rb
ruby -I"$CORE" -I"$SERVER" -I"$RAILS" packages/ruby/openreceive-rails/test/controller_test.rb
ruby -I"$CORE" -I"$SERVER" tools/conformance/ruby-crosslang.rb
