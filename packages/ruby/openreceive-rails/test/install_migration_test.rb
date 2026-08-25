# frozen_string_literal: true

# The generated migration, actually loaded and run.
#
# Asserting that the file was created is not enough: Rails resolves a migration
# class from its FILE NAME through `camelize`, and the engine registers an
# "OpenReceive" acronym inflection (see Engine, "openreceive.inflections"), so
# `create_openreceive_tables.rb` must define `CreateOpenReceiveTables`. A
# template whose class name camelizes differently renders, compiles, and passes
# every content assertion — and then fails the second command of the quickstart
# with `NameError: uninitialized constant CreateOpenReceiveTables`.
#
# This suite lives in its own file because it registers that acronym process
# wide, exactly as a booted host app does; rails_test.rb runs without it.

require "minitest/autorun"
require "active_record"
require "active_support/core_ext/string/inflections"
require "rails/generators"
require "rails/generators/test_case"
require "tmpdir"
require "fileutils"
require "openreceive/rails"
require_relative "../lib/generators/openreceive/install/install_generator"

# Mirrors OpenReceive::Engine's "openreceive.inflections" initializer, which is
# what makes this test reproduce a real host app rather than a bare process.
ActiveSupport::Inflector.inflections(:en) do |inflect|
  inflect.acronym "OpenReceive"
end

class OpenReceiveInstallMigrationRunsTest < Rails::Generators::TestCase
  tests OpenReceive::Generators::InstallGenerator
  destination File.join(Dir.tmpdir, "openreceive-install-migration-test")
  setup :prepare_destination

  setup do
    ActiveRecord::Base.establish_connection(adapter: "sqlite3", database: ":memory:")
    ActiveRecord::Migration.verbose = false
  end

  teardown do
    ActiveRecord::Base.connection_handler.clear_all_connections!
    FileUtils.rm_rf(destination_root)
  end

  def test_the_generated_migration_name_camelizes_to_the_class_it_defines
    run_generator %w[--skip-initializer --skip-route]

    path = migration_path
    class_name = File.basename(path, ".rb").sub(/\A\d+_/, "").camelize
    assert_equal "CreateOpenReceiveTables", class_name
    assert_includes File.read(path), "class #{class_name} < ActiveRecord::Migration["
  end

  def test_bin_rails_db_migrate_creates_both_engine_tables
    run_generator %w[--skip-initializer --skip-route]

    ActiveRecord::MigrationContext.new(File.join(destination_root, "db/migrate")).migrate

    connection = ActiveRecord::Base.lease_connection
    assert connection.table_exists?(:openreceive_payments)
    assert connection.table_exists?(:openreceive_meta)
    assert connection.index_exists?(:openreceive_payments, :payment_hash, unique: true)

    version = connection.select_value(
      "SELECT value FROM openreceive_meta WHERE key = 'schema_version'"
    )
    assert_equal OpenReceive::Server::PAYMENTS_SCHEMA_VERSION.to_s, version.to_s
  end

  def test_the_payment_hash_constraint_rejects_a_non_hex_hash
    run_generator %w[--skip-initializer --skip-route]
    ActiveRecord::MigrationContext.new(File.join(destination_root, "db/migrate")).migrate

    # Raw SQL, not OpenReceivePayment: the engine's models are autoloaded by a
    # booted host app, and this suite runs the migration without one. The check
    # constraint is a property of the schema either way.
    assert_raises(ActiveRecord::StatementInvalid) do
      ActiveRecord::Base.lease_connection.execute(<<~SQL.squish)
        INSERT INTO openreceive_payments
          (reference, payment_hash, status, expires_at, checkout_data, inserted_at,
           created_at, updated_at)
        VALUES
          ('order-1', '#{"z" * 64}', 'pending', '2099-01-01', '{}', '2099-01-01',
           '2099-01-01', '2099-01-01')
      SQL
    end
  end

  private

  def migration_path
    Dir[File.join(destination_root, "db/migrate/*_create_openreceive_tables.rb")].sole
  end
end
