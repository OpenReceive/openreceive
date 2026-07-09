# frozen_string_literal: true

# Cross-language conformance: prove the Ruby engine produces byte-identical hashes to the Node
# engine for the shared vectors. The vectors were generated from the Node core functions, so a
# green run here is a direct JS<->Ruby parity check (spec PART 9). Run via `npm run test:ruby`.
#
#   ruby -Ipackages/ruby/openreceive/lib -Ipackages/ruby/openreceive-server/lib \
#     tools/conformance/ruby-crosslang.rb

require "json"
require "openreceive"
require "openreceive/server"

ROOT = File.expand_path("../..", __dir__)
failures = []

def load_vector(name)
  JSON.parse(File.read(File.join(ROOT, "spec", "test-vectors", name)))
end

# 1. Idempotency canonical-JSON hash equality (same logical request -> same sha256:).
idempotency = load_vector("idempotency-canonical-json.crosslang.json")
idempotency.fetch("cases").each do |vector|
  actual_json = OpenReceive::Idempotency.canonical_json(vector.fetch("request"))
  expected_json = vector.fetch("canonical_json")
  if actual_json != expected_json
    failures << "idempotency canonical_json mismatch for #{vector['name']}:\n  expected #{expected_json}\n  actual   #{actual_json}"
  end

  actual_hash = OpenReceive::Idempotency.request_hash(vector.fetch("request"))
  expected_hash = vector.fetch("expected_request_hash")
  if actual_hash != expected_hash
    failures << "idempotency request_hash mismatch for #{vector['name']}: expected #{expected_hash}, got #{actual_hash}"
  end
end

# 2. Capability-token hashing equality (same raw token -> same stored hash).
tokens = load_vector("capability-token.json")
tokens.fetch("cases").each do |vector|
  actual = OpenReceive::Server::Tokens.hash_token(vector.fetch("token"))
  expected = vector.fetch("expected_hash")
  if actual != expected
    failures << "capability-token hash mismatch for token #{vector['token'].inspect}: expected #{expected}, got #{actual}"
  end
end

idempotency_cases = idempotency.fetch("cases").length
token_cases = tokens.fetch("cases").length

if failures.empty?
  puts "Ruby cross-language conformance passed (#{idempotency_cases} idempotency + #{token_cases} capability-token cases)."
else
  warn "Ruby cross-language conformance FAILED:"
  failures.each { |failure| warn "- #{failure}" }
  exit 1
end
