# frozen_string_literal: true

require "rails/command"
require "openreceive/skills"

module Rails
  module Command
    # A Rails command accepts --dir before the Rake fallback parses arguments.
    # It does not boot the application or require wallet credentials.
    class OpenreceiveCommand < Base
      desc "skills", "Install the bundled OpenReceive agent skills into this project"
      method_option :dir, type: :string, default: ".agents/skills"
      def skills
        OpenReceive::Skills.install(directory: options[:dir])
      end
    end
  end
end
