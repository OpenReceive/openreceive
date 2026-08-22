# frozen_string_literal: true

# The committed db/migrate/*_create_openreceive_tables.rb is a snapshot of the
# openreceive-rails install generator's migration template, rendered for this
# app (postgres adapter). `order_id` is an opaque string with no foreign key:
# the engine never reads, writes, locks, or references the host `orders` table.
# Nothing else notices when the library template changes — the app boots from
# db/schema.rb — so this check re-renders the template through the generator
# class it ships in and diffs the result against the committed migration.
#
# On drift, regenerate the snapshot the same way it was originally produced:
#
#   bin/rails generate openreceive:install --skip-initializer --skip-route
#
# keep the original timestamped filename, and re-apply the one local
# normalization below (the class name).

require "bundler/setup"
require "erb"
require "active_record"
require "rails/generators"
require "generators/openreceive/install/install_generator"
require "openreceive/server"

app_root = File.expand_path("..", __dir__)

committed_path = Dir[File.join(app_root, "db/migrate/*_create_openreceive_tables.rb")].max
if committed_path.nil?
  abort "check-migration-drift: no committed db/migrate/*_create_openreceive_tables.rb found."
end
committed = File.read(committed_path)

template_path = File.join(OpenReceive::Generators::InstallGenerator.source_root, "migration.rb")
template = File.read(template_path)

# Render exactly as `rails generate openreceive:install` does for this app. Outside a booted app there is no connection config, so the
# generator's adapter probe falls back to the non-MySQL rendering — which is the
# postgres rendering this app committed (postgres and sqlite share it; the
# adapter branch stays inside the migration and runs at migration time).
generator = OpenReceive::Generators::InstallGenerator.new([], {})
rendered = ERB.new(template, trim_mode: "-").result(generator.instance_eval { binding })

# The engine registers the `OpenReceive` inflector acronym, so in this app the
# migration file name camelizes to CreateOpenReceiveTables — the class name the
# committed snapshot must carry for `bin/rails db:migrate` to resolve it. The
# template's literal spelling is normalized to match.
rendered = rendered.sub("class CreateOpenreceiveTables", "class CreateOpenReceiveTables")

failures = []

if rendered != committed
  rendered_lines = rendered.lines
  committed_lines = committed.lines
  diff = []
  [rendered_lines.length, committed_lines.length].max.times do |index|
    expected = rendered_lines[index]
    actual = committed_lines[index]
    next if expected == actual

    diff << "  line #{index + 1}:"
    diff << "    generator: #{expected.nil? ? '<missing>' : expected.chomp.inspect}"
    diff << "    committed: #{actual.nil? ? '<missing>' : actual.chomp.inspect}"
    break if diff.length >= 30
  end
  failures << (
    "#{committed_path.delete_prefix("#{app_root}/")} has drifted from the " \
    "openreceive-rails install generator template " \
    "(#{template_path.delete_prefix("#{File.expand_path("../../../..", app_root)}/")}):" \
    "\n#{diff.join("\n")}"
  )
end

# db/schema.rb is the snapshot the app actually boots from (db:prepare loads the
# schema, not the migrations). Spot-check that the engine-owned surface the
# migration creates is present in it.
schema = File.read(File.join(app_root, "db/schema.rb"))
[
  'create_table "openreceive_payments"',
  'create_table "openreceive_meta"',
  "openreceive_payments_status_check",
  "openreceive_payments_payment_hash_check",
  "payment_hash::text ~ '^[0-9a-f]{64}$'"
].each do |needle|
  next if schema.include?(needle)

  failures << (
    "db/schema.rb is missing #{needle.inspect} — the schema snapshot no longer " \
    "matches the committed openreceive migration. Re-run the migration against " \
    "a fresh database and commit the regenerated db/schema.rb."
  )
end

unless failures.empty?
  warn "OpenReceive migration snapshot has drifted from the library-owned schema:"
  failures.each { |failure| warn "- #{failure}" }
  exit 1
end

puts "Migration drift check passed: #{File.basename(committed_path)} matches the " \
     "openreceive-rails generator template (schema version " \
     "#{OpenReceive::Server::PAYMENTS_SCHEMA_VERSION}) and db/schema.rb carries the engine tables."
