# frozen_string_literal: true

require_relative "generated/fulfillment_note"

module OpenReceive
  # The ONE canonical statement of the host's exactly-once fulfillment duty —
  # what the engine guarantees about on_paid and where that guarantee stops —
  # rendered wherever the install generator writes host-facing code.
  #
  # The text lives in spec/data/fulfillment-note.txt and is generated into both
  # this gem and @openreceive/core, so the Rails install generator and the
  # scaffold CLI cannot give different advice.
  module FulfillmentNote
    DEFAULT_TABLE = "openreceive_payments"

    module_function

    # The note with every line given +prefix+ (already including any trailing
    # space). Pass "# " for Ruby comments, "-- " for SQL, or "" for prose.
    # Blank lines drop the prefix's trailing space, so no comment block ends up
    # with trailing whitespace an editor or linter would strip.
    def render(prefix: "", table: DEFAULT_TABLE)
      lines(table: table).map { |line| line.empty? ? prefix.rstrip : "#{prefix}#{line}" }.join("\n")
    end

    def lines(table: DEFAULT_TABLE)
      Generated::FULFILLMENT_NOTE_TEMPLATE.map { |line| line.gsub("{{table}}", table) }
    end
  end
end
