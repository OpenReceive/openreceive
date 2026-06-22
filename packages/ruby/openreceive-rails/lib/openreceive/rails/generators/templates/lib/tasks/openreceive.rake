# frozen_string_literal: true

namespace :openreceive do
  desc "Check OpenReceive Rails storage, NWC, and poll readiness"
  task doctor: :environment do
    result = OpenReceive::Rails.adapter.doctor
    result.fetch("checks").each do |check|
      puts "[#{check.fetch("status")}] #{check.fetch("name")}: #{check.fetch("message")}"
    end
    abort "OpenReceive doctor failed." unless result.fetch("ok")
  end

  desc "Poll recoverable OpenReceive invoices once through backend lookup"
  task poll: :environment do
    invoices = OpenReceive::Rails.adapter.poll_recoverable_invoices
    puts "OpenReceive polled #{invoices.length} invoice(s)."
  end
end
