Gem::Specification.new do |spec|
  spec.name = "openreceive-rails"
  spec.version = "0.1.0"
  spec.summary = "Rails adapter helpers for OpenReceive"
  spec.description = "Server-side Rails adapter helpers for OpenReceive receive checkout."
  spec.authors = ["OpenReceive contributors"]
  spec.email = ["security@openreceive.org"]
  spec.license = "MIT"
  spec.required_ruby_version = ">= 2.6"
  spec.files = Dir["lib/**/*.rb", "README.md"]
  spec.require_paths = ["lib"]
  spec.add_dependency "openreceive", "= 0.1.0"
  spec.metadata = {
    "source_code_uri" => "https://github.com/openreceive/openreceive",
    "rubygems_mfa_required" => "true"
  }
end
