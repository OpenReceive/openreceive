# frozen_string_literal: true

source "https://rubygems.org"

# Test-only dependencies for the Ruby engine suites.
#
# The published gems declare their own runtime dependencies in their gemspecs
# (openreceive: bigdecimal; openreceive-server: openreceive; openreceive-rails:
# openreceive, openreceive-server, rails); this Gemfile exists purely so CI can
# install what packages/ruby/openreceive-rails/test/rails_test.rb needs INSIDE
# its container rather than relying on gems that happen to be installed on the
# runner host.
# Bounds mirror packages/ruby/openreceive-rails/openreceive-rails.gemspec:
# `rails >= 8.0` is that gem's runtime dependency and sqlite3 its development
# dependency. Keep them in sync when the gemspec changes — a looser bound here
# would let CI bundle a Rails the gem itself refuses to install against.
group :test do
  gem "rails", ">= 8.0"
  gem "sqlite3", ">= 2.1"
  gem "minitest", ">= 5.0"
end
