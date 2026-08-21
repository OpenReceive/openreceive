# frozen_string_literal: true

module OpenReceive
  # One reconciliation pass, wrapped for the host's ActiveJob backend. Schedule
  # it with the host's recurring-job system (for example a solid_queue
  # config/recurring.yml entry, sidekiq-cron, or clockwork); OpenReceive ships
  # no scheduler of its own.
  class ReconcileJob < ActiveJob::Base
    queue_as :default

    def perform
      OpenReceive.reconcile!
    end
  end
end
