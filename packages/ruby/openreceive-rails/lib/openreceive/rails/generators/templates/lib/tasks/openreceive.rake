# frozen_string_literal: true

namespace :openreceive do
  desc "Poll recoverable OpenReceive invoices once through backend lookup"
  task poll: :environment do
    invoices = OpenReceive::Rails.adapter.poll_recoverable_invoices
    puts "OpenReceive polled #{invoices.length} invoice(s)."
  end

  desc "Listen for OpenReceive payment_received notifications"
  task listen: :environment do
    OpenReceive::Rails.adapter.listen_for_payment_notifications
  end
end
