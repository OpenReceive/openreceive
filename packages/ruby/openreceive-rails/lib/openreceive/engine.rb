# frozen_string_literal: true

module OpenReceive
  class Engine < ::Rails::Engine
    isolate_namespace OpenReceive

    # Zeitwerk would otherwise camelize the "openreceive/" directory to Openreceive.
    initializer "openreceive.inflections", before: :set_autoload_paths do
      ActiveSupport::Inflector.inflections(:en) do |inflect|
        inflect.acronym "OpenReceive"
      end
    end

    # Boot fails closed for real: in production the service — and its wallet
    # preflight — is built eagerly, so a missing NWC_URI, a dead relay, or a
    # spend-capable wallet stops the deploy instead of surfacing as
    # customer-facing 500s on the first checkout. Skipped when the host never
    # ran OpenReceive.configure (gem installed, installer not run yet), and
    # outside production so tests and consoles boot without a live wallet.
    config.after_initialize do
      if OpenReceive.configured?
        if OpenReceive.config.on_paid.equal?(OpenReceive::LOGGING_ON_PAID)
          ::Rails.logger&.warn(
            "[openreceive] config.on_paid is still the generated logging placeholder — " \
            "orders will be recorded as settled without any fulfillment. Replace it in " \
            "config/initializers/openreceive.rb."
          )
        end
        OpenReceive.config.service if ::Rails.env.production?
      end
    end
  end
end
