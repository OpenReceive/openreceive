# frozen_string_literal: true

require "digest"
require "json"

module OpenReceive
  # Durable scan slices store only identities, offsets and minimal classifications.
  module ReconcileScan
    module_function

    def new_window(attempts, now, overlap)
      trusted = attempts.all? { |a| a["created_at_source"] == "wallet" }
      {
        "attempts" => attempts,
        "from" => trusted ? [attempts.map { |a| a.fetch("created_at") }.min - overlap, 0].max : 0,
        "until" => trusted ? attempts.map { |a| a.fetch("created_at") }.max + overlap : nil,
        "view" => "default", "offset" => 0, "anchor_offset" => nil, "fingerprint" => nil,
        "started_at" => now, "absence_safe" => true, "observations" => {}
      }
    end

    def slice(service, window, max_pages:, deadline:, on_finality: nil)
      results = {}
      expected = window.fetch("attempts").map { |a| a.fetch("payment_hash") }
      resumed = window.fetch("offset").positive? || window.fetch("view") != "default"
      window["absence_safe"] = false if resumed
      anchor = resumed ? window["anchor_offset"] : nil
      replaying = !anchor.nil?
      previous = window["fingerprint"]
      max_pages.times do
        break if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline

        offset = replaying ? anchor : window.fetch("offset")
        request = { "type" => "incoming", "limit" => 20, "offset" => offset, "from" => window.fetch("from") }
        request["until"] = window["until"] unless window["until"].nil?
        request["unpaid"] = true if window.fetch("view") == "inclusive"
        request["_deadline"] = deadline
        page = OpenReceive.normalize_list_transactions_response(service.send(:call_nwc, :list_transactions, request))
        return [results.values, false, false] if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline

        rows = page.fetch("transactions")
        physical = rows.length + page.fetch("skipped_rows", 0)
        fingerprint = Digest::SHA256.hexdigest(JSON.generate(rows.map { |row| row["payment_hash"] }))
        rows.each do |row|
          hash = row["payment_hash"]
          next unless expected.include?(hash) && [nil, "incoming"].include?(row["type"])
          next if window.fetch("observations").dig(hash, "status") == "settled"

          status = OpenReceive::Settlement.status(row)
          if %w[settled expired failed].include?(status)
            results[hash] = service.send(:payment_result, hash, row)
            on_finality&.call(results[hash]) if Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
          end
          window.fetch("observations")[hash] = { "status" => status, "transaction_state" => row["transaction_state"] }
        end
        if replaying
          replaying = false
          window["offset"] = offset + physical
          previous = fingerprint
          unless physical.zero?
            window["anchor_offset"] = offset
            window["fingerprint"] = fingerprint
            next
          end
        end
        if physical.zero?
          if window.fetch("view") == "default"
            window.merge!("view" => "inclusive", "offset" => 0, "anchor_offset" => nil, "fingerprint" => nil)
            previous = nil
            next
          end
          if window.fetch("absence_safe")
            expected.each do |hash|
              observation = window.fetch("observations")[hash]
              next if results.key?(hash) || %w[settled expired failed].include?(observation&.fetch("status"))

              result = { "payment_hash" => hash, "status" => observation.nil? ? "not_found" : observation.fetch("status"), "_coverage_started_at" => window.fetch("started_at") }
              result["details"] = { "transaction" => { "transaction_state" => observation["transaction_state"] } } unless observation.nil?
              results[hash] = result
            end
          end
          return [results.values, true, false]
        end
        return [results.values, false, true] if fingerprint == previous

        window.merge!("anchor_offset" => offset, "fingerprint" => fingerprint, "offset" => offset + physical)
        previous = fingerprint
        return [results.values, true, false] if expected.all? { |hash| %w[settled expired failed].include?(window.fetch("observations").dig(hash, "status")) }
      end
      [results.values, false, false]
    end
  end
end
