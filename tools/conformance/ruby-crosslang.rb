# frozen_string_literal: true

require "openreceive"

raise "fiat parity failed" unless OpenReceive.quote_fiat_to_msats(
  fiat_value: "10.00", btc_fiat_price: "50000.00"
) == 20_000_000

puts "ruby storage-free conformance: ok"
