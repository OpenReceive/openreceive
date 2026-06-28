# frozen_string_literal: true

require "rails/generators"

module Openreceive
  module Generators
    class InstallGenerator < Rails::Generators::Base
      source_root File.expand_path(
        "../../../openreceive/rails/generators/templates",
        __dir__
      )

      def copy_controller
        copy_file "config/initializers/openreceive.rb",
                  "config/initializers/openreceive.rb"
        copy_file "app/controllers/openreceive_controller.rb",
                  "app/controllers/openreceive_controller.rb"
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
