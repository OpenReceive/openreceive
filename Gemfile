# frozen_string_literal: true

source "https://rubygems.org"

# Test-only dependencies for the Ruby engine suites.
#
# The published gems declare their own runtime dependencies in their gemspecs
# (openreceive: bigdecimal; openreceive-server: openreceive; openreceive-rails:
# openreceive, openreceive-server, rails, nwc-ruby); this Gemfile exists purely
# so CI can install what the Ruby suites need INSIDE its container rather than
# relying on gems that happen to be installed on the runner host.
# Bounds mirror packages/ruby/openreceive-rails/openreceive-rails.gemspec:
# `rails >= 8.0` and `nwc-ruby ~> 0.2` are that gem's runtime dependencies and
# sqlite3 its development one. Keep them in sync when the gemspec changes — a
# looser bound here would let CI bundle a Rails the gem itself refuses to
# install against.
group :test do
  gem "rails", ">= 8.0"
  gem "sqlite3", ">= 2.1"
  gem "minitest", ">= 5.0"
  # The engine's default wallet client. It is a RUNTIME dependency of
  # openreceive-rails, so the suite must drive the real gem: every other Ruby
  # test uses a hand-written fake mirroring its API, and a green suite against
  # a gem nobody installs is how the missing dependency shipped in 0.2.1.
  gem "nwc-ruby", "~> 0.2", ">= 0.2.4"
end
