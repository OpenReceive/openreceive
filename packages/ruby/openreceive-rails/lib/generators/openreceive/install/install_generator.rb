# frozen_string_literal: true

require "rails/generators/base"
require "rails/generators/active_record"
require "rails/generators/active_record/migration"

module OpenReceive
  module Generators
    class InstallGenerator < ::Rails::Generators::Base
      include ::ActiveRecord::Generators::Migration

      namespace "openreceive:install"
      source_root File.expand_path("templates", __dir__)
      desc "Installs the OpenReceive routes, initializer, and one migration creating both " \
           "engine tables (openreceive_payments and the openreceive_meta reconcile gate). " \
           "The OpenReceivePayment model is engine-owned; only the tables live in the host database."

      class_option :skip_initializer, type: :boolean, default: false
      class_option :skip_route, type: :boolean, default: false
      class_option :skip_migration, type: :boolean, default: false
      class_option :skip_foreign_key, type: :boolean, default: false
      class_option :order_model, type: :string, default: "Order"
      class_option :order_table, type: :string
      class_option :order_primary_key_type,
                   type: :string,
                   default: "bigint",
                   enum: %w[bigint integer uuid string]

      def create_openreceive_migration
        return if options[:skip_migration]

        migration_template "migration.rb", "db/migrate/create_openreceive_tables.rb"
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

      # Mirrors the JS OPENRECEIVE_PAYMENTS_SCHEMA_VERSION.
      def schema_version
        OpenReceive::Server::PAYMENTS_SCHEMA_VERSION
      end

      # Postgres has regex matching; sqlite needs GLOB. Emitted as a Ruby
      # string literal so the migration carries the right one for the adapter
      # the app actually runs.
      def payment_hash_check_sql
        <<~RUBY.strip
          if connection.adapter_name.downcase.include?("postgres")
                           "payment_hash ~ '^[0-9a-f]{64}$'"
                         else
                           "length(payment_hash) = 64 AND payment_hash NOT GLOB '*[^0-9a-f]*'"
                         end
        RUBY
      end
    end
  end
end
