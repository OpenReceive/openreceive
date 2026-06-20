# frozen_string_literal: true

require "rails/generators"

module Openreceive
  module Generators
    class InstallGenerator < Rails::Generators::Base
      source_root File.expand_path(
        "../../../openreceive/rails/generators/templates",
        __dir__
      )

      def copy_migration_and_model_templates
        copy_file "create_openreceive_tables.rb",
                  "db/migrate/create_openreceive_tables.rb"
        copy_file "openreceive_invoice.rb",
                  "app/models/open_receive_invoice.rb"
      end

      def copy_controller_jobs_and_channel
        copy_file "app/controllers/openreceive_controller.rb",
                  "app/controllers/openreceive_controller.rb"
        copy_file "app/jobs/openreceive_poll_invoice_job.rb",
                  "app/jobs/openreceive_poll_invoice_job.rb"
        copy_file "app/jobs/openreceive_payment_received_job.rb",
                  "app/jobs/openreceive_payment_received_job.rb"
        copy_file "app/channels/openreceive_invoice_channel.rb",
                  "app/channels/openreceive_invoice_channel.rb"
        copy_file "app/views/openreceive/_invoice.html.erb",
                  "app/views/openreceive/_invoice.html.erb"
      end

      def show_route_instructions
        say "Add these routes to config/routes.rb:", :green
        say File.read(File.join(self.class.source_root, "config/openreceive_routes.rb"))
      end
    end
  end
end
