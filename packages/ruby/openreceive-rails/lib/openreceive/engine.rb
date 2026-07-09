# frozen_string_literal: true

# The mountable Rails engine. Defined ONLY when Rails is present (the require in
# `openreceive/rails.rb` is guarded), so the rest of the gem loads for syntax/structure checks and
# pure-Ruby unit tests without Rails installed. The framework is always referenced as `::Rails` to
# avoid shadowing by the `OpenReceive::Rails` namespace.
module OpenReceive
  class Engine < ::Rails::Engine
    # Isolate the engine's controllers/routes under the OpenReceive namespace so host apps mount it
    # cleanly at any prefix (`mount OpenReceive::Engine => "/openreceive"`).
    isolate_namespace OpenReceive

    # Routes live in config/routes.rb (drawn against this engine).

    # Fail-closed policy surfacing. When the host did not set an authorize hook, the default policy
    # applies: Tier 1 allow, Tier 2 iff a valid per-order token is presented, Tier 3 (invoice.sweep)
    # DENY. That is safe by construction (the sweep action returns 403), but silent — so we log a
    # loud error at boot. We deliberately DO NOT crash the host boot: fail-closed-at-request plus a
    # loud log beats taking the whole app down over a missing optional hook.
    initializer "openreceive.fail_closed_warning" do |app|
      app.config.after_initialize do
        OpenReceive::Engine.warn_if_authorize_unset
      end
    end

    # Emit the boot-time fail-closed warning (extracted so it is easy to unit-test / re-invoke).
    def self.warn_if_authorize_unset
      return if OpenReceive.config.authorize_configured?

      message =
        "[openreceive] No config.authorize hook is configured. Tier 3 routes " \
        "(POST /admin/sweep, action=invoice.sweep) FAIL CLOSED and return 403; Tier 2 routes allow " \
        "only holders of a valid per-order capability token. Configure OpenReceive.configure { |c| " \
        "c.authorize = ->(ctx) { ... } } to grant privileged access."

      logger = (::Rails.logger if defined?(::Rails) && ::Rails.respond_to?(:logger))
      if logger
        logger.error(message)
      else
        warn(message)
      end
    end
  end
end
