# frozen_string_literal: true

require "openreceive"
require "openreceive/server/tokens"
require "json"

raise "fiat parity failed" unless OpenReceive.quote_fiat_to_msats(
  fiat_value: "10.00", btc_fiat_price: "50000.00"
) == 20_000_000

vector = JSON.parse(File.read("spec/test-vectors/stateless-token.json"))
manager = OpenReceive::Server::Tokens::Manager.new(keys: vector.fetch("keyring"), clock: -> { 1000 })
cross = vector.fetch("cross_language")
opened = manager.open(cross.fetch("purpose"), cross.fetch("token"))
cross.fetch("payload").each do |key, value|
  raise "cross-language token mismatch: #{key}" unless opened[key] == value
end

begin
  manager.open("swap", cross.fetch("token"))
  raise "wrong-purpose token unexpectedly opened"
rescue OpenReceive::Server::Tokens::InvalidToken
end

parts = cross.fetch("token").split(".")
parts[4] = (parts[4][0] == "A" ? "B" : "A") + parts[4][1..-1]
begin
  manager.open("cap", parts.join("."))
  raise "tampered token unexpectedly opened"
rescue OpenReceive::Server::Tokens::InvalidToken
end

expired = OpenReceive::Server::Tokens::Manager.new(
  keys: vector.fetch("keyring"), clock: -> { cross.dig("payload", "expiresAt") }
)
begin
  expired.open("cap", cross.fetch("token"))
  raise "expired token unexpectedly opened"
rescue OpenReceive::Server::Tokens::InvalidToken
end

puts "ruby storage-free conformance: ok"
