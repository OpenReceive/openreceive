# frozen_string_literal: true

# Load only the version constant, never the full library: the gemspec is
# evaluated by `gem build` with no load path set up.
require_relative "lib/openreceive/version"

Gem::Specification.new do |spec|
  spec.name = "openreceive"
  spec.version = OpenReceive::VERSION
  spec.summary = "OpenReceive Ruby core helpers"
  spec.description = "Vector-backed Ruby helpers for OpenReceive receive-checkout contracts."
  spec.authors = ["OpenReceive"]
  spec.email = ["info@openreceive.org"]
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.2"
  spec.homepage = "https://openreceive.org"
  # bigdecimal is a bundled gem from Ruby 3.4; declare it explicitly.
  spec.add_dependency "bigdecimal"
  # skills/ is the agent-skills copy kept in sync by `npm run generate:skills`.
  spec.files = Dir["lib/**/*.rb", "skills/**/*.md", "README.md", "CHANGELOG.md", "LICENSE"]
  spec.require_paths = ["lib"]
  spec.metadata = {
    "homepage_uri" => "https://openreceive.org",
    "source_code_uri" => "https://github.com/openreceive/openreceive",
    "changelog_uri" => "https://github.com/openreceive/openreceive/blob/master/packages/ruby/openreceive/CHANGELOG.md",
    "bug_tracker_uri" => "https://github.com/openreceive/openreceive/issues",
    "documentation_uri" => "https://rubydoc.info/gems/openreceive",
    "rubygems_mfa_required" => "true"
  }
end
