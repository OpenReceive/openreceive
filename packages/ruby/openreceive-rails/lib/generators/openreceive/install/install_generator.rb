# frozen_string_literal: true

require "rails/generators/base"
require "rails/generators/migration"
require "active_record"

module OpenReceive
  module Generators
    # `rails generate openreceive:install`
    #
    # Writes config/initializers/openreceive.rb, mounts the engine in config/routes.rb, and copies
    # the canonical migrations into db/migrate with fresh timestamps. The migration superclass
    # version is resolved to the host's Rails version at generate time (floor: Rails 7.1).
    #
    # The generator namespace is set explicitly so the command is `openreceive:install` regardless
    # of how the class name inflects.
    class InstallGenerator < ::Rails::Generators::Base
      include ::Rails::Generators::Migration

      namespace "openreceive:install"

      source_root File.expand_path("templates", __dir__)

      desc "Installs OpenReceive: initializer, engine mount, and migrations."

      class_option :skip_initializer, type: :boolean, default: false,
                                      desc: "Do not create config/initializers/openreceive.rb"
      class_option :skip_route, type: :boolean, default: false,
                                desc: "Do not mount the engine in config/routes.rb"
      class_option :skip_migrations, type: :boolean, default: false,
                                     desc: "Do not copy the migrations"

      def create_initializer
        return if options[:skip_initializer]

        template "initializer.rb", "config/initializers/openreceive.rb"
      end

      def mount_engine
        return if options[:skip_route]

        route %(mount OpenReceive::Engine => "/openreceive")
      end

      def copy_migrations
        return if options[:skip_migrations]

        migration_template "create_openreceive_invoices.rb.tt",
                           "db/migrate/create_openreceive_invoices.rb"
        migration_template "add_openreceive_order_access_token.rb.tt",
                           "db/migrate/add_openreceive_order_access_token.rb"
      end

      # Required by Rails::Generators::Migration so migration_template can assign timestamps. Two
      # migration_template calls in one run get ordered numbers via current_migration_number.
      def self.next_migration_number(dirname)
        next_number = current_migration_number(dirname) + 1
        ::ActiveRecord::Migration.next_migration_number(next_number)
      end

      private

      # Migration superclass version: the host's Rails version at generate time, floored at 7.1.
      # Emitted into the templates as `ActiveRecord::Migration[<version>]`.
      def migration_version
        floor = 7.1
        current =
          if defined?(::ActiveRecord::Migration) && ::ActiveRecord::Migration.respond_to?(:current_version)
            ::ActiveRecord::Migration.current_version.to_f
          else
            ::Rails::VERSION::STRING.to_f
          end
        format("%.1f", current >= floor ? current : floor)
      rescue StandardError
        "7.1"
      end
    end
  end
end
