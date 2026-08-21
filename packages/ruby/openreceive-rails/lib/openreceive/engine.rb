# frozen_string_literal: true

module OpenReceive
  class Engine < ::Rails::Engine
    isolate_namespace OpenReceive

    # Zeitwerk would otherwise camelize the "openreceive/" directory to Openreceive.
    initializer "openreceive.inflections", before: :set_autoload_paths do
      ActiveSupport::Inflector.inflections(:en) do |inflect|
        inflect.acronym "OpenReceive"
      end
    end
  end
end
