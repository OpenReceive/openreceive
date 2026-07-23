# frozen_string_literal: true

require "rails/generators/base"
require "rails/generators/active_record"

module OpenReceive
  module Generators
    class InstallGenerator < ::Rails::Generators::Base
      include ::Rails::Generators::Migration

      namespace "openreceive:install"
      source_root File.expand_path("templates", __dir__)
      desc "Installs OpenReceive routes and host-owned payment-attempt scaffolding."

      class_option :skip_initializer, type: :boolean, default: false
      class_option :skip_route, type: :boolean, default: false
      class_option :skip_payment_model, type: :boolean, default: false
      class_option :skip_payment_migration, type: :boolean, default: false
      class_option :skip_foreign_key, type: :boolean, default: false
      class_option :order_model, type: :string, default: "Order"
      class_option :order_table, type: :string
      class_option :order_primary_key_type,
                   type: :string,
                   default: "bigint",
                   enum: %w[bigint integer uuid string]

      def self.next_migration_number(dirname)
        if ::ActiveRecord::Base.timestamped_migrations
          Time.now.utc.strftime("%Y%m%d%H%M%S")
        else
          format("%.3d", current_migration_number(dirname) + 1)
        end
      end

      def create_payment_model
        return if options[:skip_payment_model]

        template "payment.rb", "app/models/open_receive_payment.rb"
      end

      def create_payment_migration
        return if options[:skip_payment_migration]

        migration_template "migration.rb", "db/migrate/create_openreceive_payments.rb"
      end

      def create_initializer
        template "initializer.rb", "config/initializers/openreceive.rb" unless options[:skip_initializer]
      end

      def mount_engine
        route %(mount OpenReceive::Engine => "/openreceive") unless options[:skip_route]
      end

      private

      def order_model_name
        options[:order_model]
      end

      def order_table_name
        options[:order_table].presence || order_model_name.underscore.pluralize
      end

      def order_primary_key_type
        options[:order_primary_key_type]
      end

      def migration_version
        "#{::ActiveRecord::VERSION::MAJOR}.#{::ActiveRecord::VERSION::MINOR}"
      end

      def add_order_foreign_key?
        !options[:skip_foreign_key]
      end
    end
  end
end
