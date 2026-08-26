# frozen_string_literal: true

module OpenReceive
  # Namespace for the Rails engine gem (openreceive-rails). This is distinct from the
  # top-level `::Rails` framework constant — engine code always references the framework as
  # `::Rails` to avoid shadowing.
  module Rails
    VERSION = "0.2.4"
  end
end
