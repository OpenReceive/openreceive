# frozen_string_literal: true

require "json"
require "openreceive"
require "yaml"

ROOT = File.expand_path("../..", __dir__)
DEFAULT_EXPECTED_CAPABILITIES = File.join(ROOT, "tools/live-nwc-test/expected_capabilities.json")

def read_expected_capabilities
  path = ENV["OPENRECEIVE_EXPECTED_CAPABILITIES"] || DEFAULT_EXPECTED_CAPABILITIES
  JSON.parse(File.read(path))
end

def read_openreceive_config_nwc
  path = File.join(Dir.pwd, "openreceive.yml")
  return nil unless File.file?(path)

  config = YAML.safe_load(File.read(path), aliases: false) || {}
  value = config["nwc"]
  value.is_a?(String) ? value.strip : nil
end

nwc = read_openreceive_config_nwc
if nwc.nil? || nwc.empty?
  puts "`nwc` is not set in openreceive.yml; skipping Ruby live NWC smoke test."
  exit 0
end

parsed = OpenReceive.parse_nwc_uri(nwc)
expected = read_expected_capabilities

puts "Ruby NWC URI parsed for wallet profile: #{expected.fetch("wallet_profile")}"
puts "Wallet pubkey prefix: #{parsed.fetch(:wallet_pubkey)[0, 8]}..."
puts "Relay count: #{parsed.fetch(:relays).length}"
puts "Connection: #{parsed.fetch(:redacted)}"
puts "Expected methods: #{expected.fetch("required_methods").join(", ")}"

begin
  raise LoadError if ENV["OPENRECEIVE_RUBY_NWC_DISABLE_GEM"] == "1"

  require "nwc_ruby"
rescue LoadError
  puts "nwc-ruby gem is not installed; skipping live Ruby wallet calls after URI/capability preflight."
  exit 0
end

raw_client = NwcRuby::Client.from_uri(nwc)
client = OpenReceive::NwcRubyReceiveClient.new(client: raw_client, connection_uri: nwc)
info = client.preflight
methods = info["methods"] || raw_client.respond_to?(:capabilities) && raw_client.capabilities || []

missing_methods = expected.fetch("required_methods").reject { |method| methods.include?(method) }
unless missing_methods.empty?
  warn "Ruby NWC preflight missing required methods: #{missing_methods.join(", ")}"
  exit 1
end

puts "Ruby NWC preflight ready: true"
puts "Advertised method count: #{methods.length}"

unless ENV["OPENRECEIVE_LIVE_CREATE_INVOICE"] == "1"
  puts "OPENRECEIVE_LIVE_CREATE_INVOICE is not 1; skipping Ruby invoice creation."
  exit 0
end

invoice = client.make_invoice(
  "amount_msats" => Integer(ENV.fetch("OPENRECEIVE_LIVE_AMOUNT_MSATS", "1000")),
  "description" => "OpenReceive Ruby live smoke"
)
transactions = client.list_transactions(
  "type" => "incoming",
  "unpaid" => true,
  "from" => invoice.fetch("created_at"),
  "until" => invoice.fetch("created_at"),
  "limit" => 25,
  "offset" => 0
).fetch("transactions")
match = transactions.find do |transaction|
  transaction["payment_hash"] == invoice.fetch("payment_hash") ||
    transaction["invoice"] == invoice.fetch("invoice")
end

puts "Created Ruby live invoice payment hash prefix: #{invoice.fetch("payment_hash")[0, 8]}..."
puts "Initial Ruby live transaction state: #{match&.fetch("transaction_state", nil) || "unknown"}"
