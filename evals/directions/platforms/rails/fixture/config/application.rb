require_relative "boot"

require "rails"
require "active_model/railtie"
require "active_record/railtie"
require "action_controller/railtie"
require "action_view/railtie"

module WidgetShop
  class Application < Rails::Application
    config.load_defaults 7.2
    config.eager_load = true
    config.api_only = false
    config.secret_key_base = ENV.fetch("SECRET_KEY_BASE")
    config.hosts.clear
  end
end
