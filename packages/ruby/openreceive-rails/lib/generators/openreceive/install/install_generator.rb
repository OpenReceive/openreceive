# frozen_string_literal: true

require "rails/generators/active_record/migration"
require "rails/generators"

module Openreceive
  module Generators
    class InstallGenerator < Rails::Generators::Base
      include Rails::Generators::Migration

      source_root File.expand_path(
        "../../../openreceive/rails/generators/templates",
        __dir__
      )

      def self.next_migration_number(dirname)
        ActiveRecord::Generators::Base.next_migration_number(dirname)
      end

      def copy_migration_and_model_templates
        migration_template "create_openreceive_tables.rb",
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
        copy_file "lib/tasks/openreceive.rake",
                  "lib/tasks/openreceive.rake"
      end

      def show_route_instructions
        say "Add these routes to config/routes.rb:", :green
        say File.read(File.join(self.class.source_root, "config/openreceive_routes.rb"))
      end
    end
  end
end
