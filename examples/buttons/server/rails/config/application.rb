require_relative "boot"

require "rails"
# Pick the frameworks you want:
require "active_model/railtie"
require "active_job/railtie"
require "active_record/railtie"
# require "active_storage/engine"
require "action_controller/railtie"
require "action_mailer/railtie"
# require "action_mailbox/engine"
# require "action_text/engine"
require "action_view/railtie"
# Settlement pushes ride ActionCable over solid_cable — database-backed, so the
# out-of-process `notifications` worker can broadcast into Puma through the
# database they already share. The broadcast fires AFTER the settlement
# transaction commits, never inside `config.on_paid`; see the initializer.
require "action_cable/engine"
# require "rails/test_unit/railtie"

# Require the gems listed in Gemfile, including any gems
# you've limited to :test, :development, or :production.
Bundler.require(*Rails.groups)

module ButtonShopRails
  class Application < Rails::Application
    config.load_defaults 8.1

    config.autoload_lib(ignore: %w[assets tasks button_shop])

    # Don't generate system test files.
    config.generators.system_tests = nil

    # uuid primary keys everywhere. `shop_orders.id` IS the OpenReceive
    # reference: created before checkout, kept across retries, never reused, and
    # unguessable because it is a uuid rather than a sequential integer.
    config.generators do |generate|
      generate.orm :active_record, primary_key_type: :uuid
    end
  end
end
