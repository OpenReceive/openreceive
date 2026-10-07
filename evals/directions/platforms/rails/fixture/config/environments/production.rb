Rails.application.configure do
  config.enable_reloading = false
  config.eager_load = true
  config.consider_all_requests_local = false
  config.public_file_server.enabled = true
  config.logger = Logger.new($stdout)
  config.log_level = :info
  config.hosts.clear
  config.force_ssl = false
end
