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
# `rails >= 7.1` is that gem's runtime dependency and sqlite3 its development
# dependency. Keep them in sync when the gemspec changes.
group :test do
  gem "rails", ">= 7.1"
  gem "sqlite3", ">= 2.1"
  gem "minitest", ">= 5.0"
end
