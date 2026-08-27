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
    #
    # `rails assets:precompile` is the one production boot that must NOT be
    # preflighted: it runs inside an image build, before any wallet secret is
    # mounted, so checking there fails the build rather than the deploy. It is
    # detected and skipped automatically (OpenReceive.eager_preflight?), and
    # `config.eager_preflight = false` is the explicit lever for any other
    # secretless boot.
    config.after_initialize do
      if OpenReceive.configured?
        if OpenReceive.config.on_paid.equal?(OpenReceive::LOGGING_ON_PAID)
          ::Rails.logger&.warn(
            "[openreceive] config.on_paid is still the generated logging placeholder — " \
            "orders will be recorded as settled without any fulfillment. Replace it in " \
            "config/initializers/openreceive.rb."
          )
        end
        if OpenReceive.config.authorize.equal?(OpenReceive::ALLOW_ALL_AUTHORIZE)
          ::Rails.logger&.warn(
            "[openreceive] config.authorize is still the generated allow-all placeholder — " \
            "anyone holding an order id can mint invoices, poll status, and request refunds " \
            "for it. Safe only while your references are unguessable. Replace it in " \
            "config/initializers/openreceive.rb."
          )
        end
        if ::Rails.env.production?
          skipped = OpenReceive.preflight_skip_reason
          if skipped.nil?
            OpenReceive.config.service
          else
            ::Rails.logger&.info(
              "[openreceive] boot preflight skipped (#{skipped}) — the wallet is " \
              "checked on the first request instead."
            )
          end
        end
      end
    end
  end
end
