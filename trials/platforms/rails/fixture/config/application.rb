require_relative "boot"

require "rails"
require "active_model/railtie"
require "active_record/railtie"
require "action_controller/railtie"
require "action_view/railtie"

# Require the gems listed in Gemfile, including any gems
# you've limited to :test, :development, or :production.
Bundler.require(*Rails.groups)

module WidgetShop
  class Application < Rails::Application
    config.load_defaults 8.1
    config.eager_load = true
    config.api_only = false
    config.secret_key_base = ENV.fetch("SECRET_KEY_BASE")
    config.hosts.clear
  end
end
