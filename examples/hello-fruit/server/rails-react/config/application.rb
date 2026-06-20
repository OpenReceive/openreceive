require "rails"
require "action_controller/railtie"
require "active_job/railtie"
require "active_record/railtie"
require "action_cable/engine"
require "openreceive/rails"

module HelloFruitRailsHotwire
  class Application < Rails::Application
    config.load_defaults 7.1
    config.eager_load = ENV["RAILS_ENV"] == "production"
    config.active_job.queue_adapter = :async
    config.secret_key_base = ENV.fetch("SECRET_KEY_BASE", "development-secret-key-base")
  end
end
