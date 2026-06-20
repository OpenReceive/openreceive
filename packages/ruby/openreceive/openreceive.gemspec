Gem::Specification.new do |spec|
  spec.name = "openreceive"
  spec.version = "0.1.0"
  spec.summary = "OpenReceive Ruby core helpers"
  spec.description = "Vector-backed Ruby helpers for OpenReceive receive-checkout contracts."
  spec.authors = ["OpenReceive contributors"]
  spec.email = ["security@openreceive.org"]
  spec.license = "MIT"
  spec.required_ruby_version = ">= 2.6"
  spec.files = Dir["lib/**/*.rb", "README.md"]
  spec.require_paths = ["lib"]
  spec.metadata = {
    "source_code_uri" => "https://github.com/openreceive/openreceive",
    "rubygems_mfa_required" => "true"
  }
end
