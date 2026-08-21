# frozen_string_literal: true

require "json"
require "openreceive"

ROOT = File.expand_path("../..", __dir__)
DEFAULT_EXPECTED_CAPABILITIES = File.join(ROOT, "tools/live-nwc-test/expected_capabilities.json")

def read_expected_capabilities
  path = ENV["OPENRECEIVE_EXPECTED_CAPABILITIES"] || DEFAULT_EXPECTED_CAPABILITIES
  JSON.parse(File.read(path))
end

# Mirrors the JS twin's process.loadEnvFile closely enough for this repo's
# .env: `export NAME=value` lines and single/double-quoted values both load.
def load_root_dotenv
  path = File.join(ROOT, ".env")
  return unless File.file?(path)

  File.foreach(path) do |line|
    entry = line.strip.sub(/\Aexport\s+/, "")
    name, value = entry.split("=", 2)
    next unless %w[NWC_URI LSC_URI_PRIMARY LSC_URI_BACKUP].include?(name)
    next if ENV.key?(name)

    ENV[name] = strip_dotenv_quotes(value.to_s.strip)
  end
end

def strip_dotenv_quotes(value)
  if value.length >= 2 &&
     ((value.start_with?('"') && value.end_with?('"')) ||
      (value.start_with?("'") && value.end_with?("'")))
    value[1..-2]
  else
    value
  end
end

load_root_dotenv
nwc = ENV["NWC_URI"]&.strip
if nwc.nil? || nwc.empty?
  puts "NWC_URI is not set; skipping Ruby live NWC smoke test."
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

# Settlement is proven through the PRODUCTION reconcile path — the server
# gem's Service#check_payment (settled-first then inclusive-unpaid walk over
# padded windows via the core scan) — never through a hand-rolled
# list_transactions query. `npm run test:live:ruby:nwc` puts only the core gem
# on the load path, so the server gem's lib is added here.
server_lib = File.join(ROOT, "packages/ruby/openreceive-server/lib")
$LOAD_PATH.unshift(server_lib) unless $LOAD_PATH.include?(server_lib)
require "openreceive/server"

service = OpenReceive::Server::Service.new(
  nwc_client: client,
  price_provider: false,
  swap_providers: [],
  # The capability check above already ran; a spend-capable wallet is warned
  # about, not refused, matching the JS smoke's warn-and-continue behavior.
  allow_spend_capable_wallet: true
)

invoice = client.make_invoice(
  "amount_msats" => Integer(ENV.fetch("OPENRECEIVE_LIVE_AMOUNT_MSATS", "1000")),
  "description" => "OpenReceive Ruby live smoke"
)
puts "Created Ruby live invoice payment hash prefix: #{invoice.fetch("payment_hash")[0, 8]}..."

def check_live_payment(service, invoice)
  service.check_payment(
    "payment_hash" => invoice.fetch("payment_hash"),
    "created_at" => invoice.fetch("created_at")
  )
rescue RuntimeError => e
  raise unless e.message.include?("reconciliation did not complete")
  # A truncated wallet-history walk proves nothing; report it as still pending
  # and let the caller scan again.
  { "payment_hash" => invoice.fetch("payment_hash"), "status" => "scan_incomplete" }
end

check = check_live_payment(service, invoice)
puts "Initial Ruby payment status via production reconcile: #{check.fetch("status")}"

unless ENV["OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT"] == "1"
  puts "Set OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT=1 to poll the production reconcile until settlement."
  exit 0
end

expires_at = invoice["expires_at"] || (invoice.fetch("created_at") + 900)
status = check.fetch("status")
until %w[settled expired failed].include?(status)
  if Time.now.to_i > expires_at
    puts "Final Ruby outcome: expired (local_expiry_elapsed)"
    exit 1
  end
  sleep 2
  status = check_live_payment(service, invoice).fetch("status")
  puts "Ruby workflow transition: #{status}"
end

puts "Final Ruby outcome: #{status}"
exit(status == "settled" ? 0 : 1)
