# frozen_string_literal: true

require "rails/generators/base"

module OpenReceive
  module Generators
    class InstallGenerator < ::Rails::Generators::Base
      namespace "openreceive:install"
      source_root File.expand_path("templates", __dir__)
      desc "Installs the storage-free OpenReceive initializer and engine mount."

      class_option :skip_initializer, type: :boolean, default: false
      class_option :skip_route, type: :boolean, default: false

      def create_initializer
        template "initializer.rb", "config/initializers/openreceive.rb" unless options[:skip_initializer]
      end

      def mount_engine
        route %(mount OpenReceive::Engine => "/openreceive") unless options[:skip_route]
      end
    end
  end
end
