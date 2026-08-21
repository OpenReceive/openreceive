# frozen_string_literal: true

require "json"
require "openreceive"
require "openreceive/server"

def vector(name)
  JSON.parse(File.read("spec/test-vectors/#{name}.json"))
end

# fiat-to-msats: every quote case must match the shared ceil-to-whole-sat rule.
fiat = vector("fiat-to-msats.usd")
fiat.fetch("cases").each do |kase|
  msats = OpenReceive.quote_fiat_to_msats(
    fiat_value: kase.dig("fiat", "value"),
    btc_fiat_price: fiat.fetch("btc_fiat_price")
  )
  unless msats == kase.dig("expected", "amount_msats")
    raise "fiat-to-msats parity failed: #{kase.fetch('name')} (got #{msats})"
  end
end

# Quotes both engines must refuse: zero/negative fiat, and a value large enough
# to push amount_msats past the wire contract's safe-integer ceiling.
fiat.fetch("invalid_cases", []).each do |kase|
  begin
    got = OpenReceive.quote_fiat_to_msats(
      fiat_value: kase.dig("fiat", "value"),
      btc_fiat_price: fiat.fetch("btc_fiat_price")
    )
    raise "fiat-to-msats parity failed: #{kase.fetch('name')} was accepted (got #{got})"
  rescue ArgumentError, TypeError
    # Refused, as required.
  end
end

# amount-boundaries: bounded msats acceptance must match exactly.
vector("amount-boundaries").fetch("cases").each do |kase|
  begin
    OpenReceive::Money.bounded_msats(kase.fetch("amount_msats"))
    valid = true
  rescue ArgumentError, TypeError
    valid = false
  end
  unless valid == kase.fetch("valid")
    raise "amount-boundaries parity failed: #{kase.fetch('name')}"
  end
end

# rate-limit-window: both engines must window the per-IP budget on the same
# immutable column, so a wallet clock or a status transition cannot move it.
rate_limit = vector("rate-limit-window")
unless rate_limit.fetch("column") == "inserted_at"
  raise "rate-limit-window parity failed: unexpected column #{rate_limit.fetch('column')}"
end
# This harness is storage-free (no ActiveRecord), so the model is checked at the
# source level: count_attempts_from_ip must window on the decided column.
model_source = File.read("packages/ruby/openreceive-rails/app/models/open_receive_payment.rb")
counting_query = model_source[/def self\.count_attempts_from_ip.*?\n  end/m].to_s
unless counting_query.include?("#{rate_limit.fetch('column')} >= ?")
  raise "rate-limit-window parity failed: the Rails model does not count on " \
        "#{rate_limit.fetch('column')}"
end
rate_limit.fetch("cases").each do |kase|
  stamp = kase.fetch("attempt").fetch(rate_limit.fetch("column"))
  counted = stamp >= kase.fetch("now") - kase.fetch("window_seconds")
  unless counted == kase.dig("expected", "counted")
    raise "rate-limit-window parity failed: #{kase.fetch('name')}"
  end
end

# swap-address: refund/deposit address validation must accept and reject the
# same addresses in both engines — a checksum, not a shape guard.
vector("swap-address").fetch("cases").each do |kase|
  actual = OpenReceive::SwapAddress.valid_for_network?(kase.fetch("network"), kase.fetch("address"))
  unless actual == kase.dig("expected", "valid")
    raise "swap-address parity failed: #{kase.fetch('name')} (got #{actual})"
  end
end

# settlement-detection: the shared finality rule (never a preimage alone).
vector("settlement-detection").fetch("cases").each do |kase|
  actual = OpenReceive::Settlement.settled?(kase.fetch("transaction"))
  unless actual == kase.dig("expected", "settled")
    raise "settlement-detection parity failed: #{kase.fetch('name')}"
  end

  # The 4-way classification, not just the settled boolean: expired and failed
  # drive different terminal reconciliation transitions.
  expected_status = kase.dig("expected", "status")
  next if expected_status.nil?

  status = OpenReceive::Settlement.status(kase.fetch("transaction"))
  unless status == expected_status
    raise "settlement-detection parity failed: #{kase.fetch('name')} " \
          "(status #{status}, expected #{expected_status})"
  end
end

# make-invoice-validation: request validation before any wallet call.
vector("make-invoice-validation").fetch("cases").each do |kase|
  request = kase.fetch("request").dup
  # The vector encodes oversized metadata by note length instead of inlining
  # kilobytes of JSON.
  if request.key?("metadata_note_length")
    request["metadata"] = { "note" => "x" * request.delete("metadata_note_length") }
  end
  begin
    OpenReceive::Nwc.make_invoice_request(request)
    valid = true
  rescue ArgumentError, KeyError, TypeError
    valid = false
  end
  unless valid == kase.dig("expected", "valid")
    raise "make-invoice-validation parity failed: #{kase.fetch('name')}"
  end
end

# nwc-request-response: NIP-47 request mapping and response normalization.
vector("nwc-request-response").fetch("cases").each do |kase|
  if kase.fetch("method") == "make_invoice"
    actual_request = OpenReceive::Nwc.make_invoice_request(kase.fetch("openreceive_request"))
    unless actual_request == kase.fetch("expected_nip47_request")
      raise "nwc-request-response parity failed: #{kase.fetch('name')} request " \
            "(got #{actual_request.inspect})"
    end
    if kase.key?("expected_openreceive_response")
      actual = OpenReceive.normalize_make_invoice_response(kase.fetch("raw_response"))
      kase.fetch("expected_openreceive_response").each do |key, value|
        unless actual[key] == value
          raise "nwc-request-response parity failed: #{kase.fetch('name')} response #{key}"
        end
      end
    end
  else
    actual_request = OpenReceive::Nwc.list_transactions_request(kase.fetch("openreceive_request"))
    unless actual_request == kase.fetch("expected_nip47_request")
      raise "nwc-request-response parity failed: #{kase.fetch('name')} request " \
            "(got #{actual_request.inspect})"
    end
    if kase.key?("expected_openreceive_response")
      actual = OpenReceive.normalize_list_transactions_response(kase.fetch("raw_response"))
      expected = kase.fetch("expected_openreceive_response")
      unless actual.fetch("transactions").length == expected.fetch("transactions").length
        raise "nwc-request-response parity failed: #{kase.fetch('name')} row count"
      end
      expected.fetch("transactions").each_with_index do |row, index|
        row.each do |key, value|
          unless actual.fetch("transactions")[index][key] == value
            raise "nwc-request-response parity failed: #{kase.fetch('name')} row #{index} #{key}"
          end
        end
      end
    end
  end
end

# nwc-info: wallet service info normalization (capabilities, encryption mode,
# spend detection, receive readiness) — mirrors the JS
# summarizeWalletCapabilities coverage in tests/nwc-boot.test.mjs.
vector("nwc-info").fetch("cases").each do |kase|
  summary = OpenReceive::Server::WalletInfo.summarize(kase.fetch("raw_info"))
  expected = kase.fetch("expected")
  checks = {
    "methods" => summary.fetch("methods") == expected.fetch("methods"),
    "encryption" => summary.fetch("encryption") == expected.fetch("encryption"),
    "spend_capability_advertised" =>
      summary.fetch("spend_capability_advertised") == expected.fetch("spend_capability_advertised"),
    "receive_checkout_ready" =>
      summary.fetch("receive_checkout_ready") == expected.fetch("receive_checkout_ready"),
    # Same extraction the JS test uses: the warned method name is quoted
    # inside each warning message.
    "warning_methods" =>
      summary.fetch("warnings").filter_map { |warning| warning[/'([^']+)'/, 1] } ==
      expected.fetch("warning_methods")
  }
  failed = checks.reject { |_, ok| ok }.keys
  unless failed.empty?
    raise "nwc-info parity failed: #{kase.fetch('name')} (#{failed.join(', ')})"
  end
end

# nwc-uri-parse: identical parse results and error codes.
vector("nwc-uri-parse").fetch("cases").each do |kase|
  if kase.key?("expected_error")
    begin
      OpenReceive.parse_nwc_uri(kase.fetch("uri"))
      raise "nwc-uri-parse parity failed: #{kase.fetch('name')} did not raise"
    rescue OpenReceive::NwcUriParseError => e
      unless e.code == kase.fetch("expected_error")
        raise "nwc-uri-parse parity failed: #{kase.fetch('name')} raised #{e.code}"
      end
    end
  else
    parsed = OpenReceive.parse_nwc_uri(kase.fetch("uri"))
    expected = kase.fetch("expected")
    checks = {
      "wallet_pubkey" => parsed[:wallet_pubkey] == expected.fetch("wallet_pubkey"),
      "relays" => parsed[:relays] == expected.fetch("relays"),
      "secret_present" => !parsed[:client_secret].to_s.empty? == expected.fetch("secret_present"),
      "lud16" => parsed[:lud16] == expected["lud16"] || (parsed[:lud16].nil? && expected["lud16"].nil?),
      "redacted" => parsed[:redacted] == expected.fetch("redacted")
    }
    failed = checks.reject { |_, ok| ok }.keys
    unless failed.empty?
      raise "nwc-uri-parse parity failed: #{kase.fetch('name')} (#{failed.join(', ')})"
    end
  end
end

# error-normalization: wallet failures map to canonical codes + retryable.
vector("error-normalization").fetch("cases").each do |kase|
  actual = OpenReceive::Nwc.normalize_wallet_error(kase.fetch("raw_error"))
  expected = kase.fetch("expected")
  expected.each do |key, value|
    unless actual[key] == value
      raise "error-normalization parity failed: #{kase.fetch('name')} #{key} " \
            "(expected #{value.inspect}, got #{actual[key].inspect})"
    end
  end
end

raise "fiat parity failed" unless OpenReceive.quote_fiat_to_msats(
  fiat_value: "10.00", btc_fiat_price: "50000.00"
) == 20_000_000

vectors = JSON.parse(File.read("spec/test-vectors/attempt-reconciliation.json"))
unless OpenReceive::Server::Reconciliation::EXPIRY_GRACE_SECONDS == vectors.fetch("expiry_grace_seconds")
  raise "attempt expiry grace drifted from the shared vectors"
end
vectors.fetch("vectors").each do |vector|
  actual = OpenReceive::Server::Reconciliation.transition(
    expires_at: vector.dig("attempt", "expires_at"),
    status: vector.fetch("status"),
    observed_at: vector.fetch("observed_at"),
    transaction_state: vector["transaction_state"]
  )
  raise "reconciliation parity failed: #{vector.fetch('name')}" unless actual == vector.fetch("expected")
end

puts "ruby storage-free conformance: ok (fiat, amounts, settlement, make-invoice, nwc-info, nwc-uri, errors, reconciliation, rate-limit-window, swap-address)"
