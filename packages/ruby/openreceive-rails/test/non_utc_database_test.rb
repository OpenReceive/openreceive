# frozen_string_literal: true

# A database that is not set to UTC. Rails normally pins every connection to
# UTC, so these sessions are forced back to Asia/Tokyo (UTC+9) after connecting,
# with the Ruby process in another zone again: the engine writes UTC wall-clock
# datetimes, so a session offset must change nothing, and the expiry boundaries
# below would catch a nine hour shift in either direction.
#
# Runs only against real servers (OPENRECEIVE_TEST_PGSQL_URL /
# OPENRECEIVE_TEST_MYSQL_URL, as repository_dialects_test.rb does);
# tools/ci/deployment-edge-tests.sh also runs it against servers in that zone.

require "minitest/autorun"
require "uri"
require "json"
require "active_record"
require "openreceive/rails"

class NonUtcDatabaseTest < Minitest::Test
  NOW = 1_794_210_000
  NINE_HOURS = 9 * 3600
  HASHES = { a: "1" * 64, b: "2" * 64, c: "3" * 64 }.freeze

  %w[PGSQL MYSQL].each do |dialect|
    define_method("test_#{dialect.downcase}_columns_hold_utc_wall_clock_in_a_tokyo_session") do
      with_tokyo_tables(dialect) do |connection, stored_text|
        created = NOW - 60
        expires = NOW + 540
        attempt = commit("ord", HASHES[:a], created, expires, client_ip: "203.0.113.1")
        assert_equal expires, attempt.expires_at.to_i
        assert_equal utc_text(expires), stored_text.call(connection, "expires_at", HASHES[:a])
        assert_equal utc_text(created), stored_text.call(connection, "created_at", HASHES[:a])
        assert_equal expires, OpenReceivePayment.find_by!(payment_hash: HASHES[:a]).expires_at.to_i
      end
    end

    define_method("test_#{dialect.downcase}_paid_at_round_trips_exactly") do
      with_tokyo_tables(dialect) do |connection, stored_text|
        commit("paid", HASHES[:b], NOW, NOW + 600)
        paid_at = NOW + 123
        assert OpenReceivePayment.mark_paid_once!(payment_hash: HASHES[:b], paid_at: paid_at) { nil }
        payment = OpenReceivePayment.find_by!(payment_hash: HASHES[:b])
        assert_equal "settled", payment.status
        assert_equal paid_at, payment.paid_at.to_i
        assert_equal utc_text(paid_at), stored_text.call(connection, "paid_at", HASHES[:b])
      end
    end

    define_method("test_#{dialect.downcase}_liveness_and_the_rate_limit_window_follow_the_clock") do
      with_tokyo_tables(dialect) do |_connection, _stored_text|
        now = Time.at(NOW)
        expires = NOW + 300
        commit("live", HASHES[:a], NOW - 60, expires, client_ip: "203.0.113.2")
        assert_equal [HASHES[:a]], OpenReceivePayment.live_at(now).where(reference: "live").pluck(:payment_hash)
        assert_empty OpenReceivePayment.live_at(Time.at(expires + 1)).where(reference: "live")
        assert_empty OpenReceivePayment.live_at(now + NINE_HOURS + 1).where(reference: "live")
        assert_equal [HASHES[:a]], OpenReceivePayment.live_at(Time.at(expires - 1)).where(reference: "live").pluck(:payment_hash)

        # inserted_at is stamped from the real clock when the row is committed,
        # not from a test clock, so the window is measured against that.
        stamped = Time.now.to_i
        assert_equal 1, OpenReceivePayment.count_attempts_from_ip("203.0.113.2", Time.at(stamped - 30))
        assert_equal 0, OpenReceivePayment.count_attempts_from_ip("203.0.113.2", Time.at(stamped + 30))
        assert_equal 1, OpenReceivePayment.count_attempts_from_ip("203.0.113.2", Time.at(stamped - NINE_HOURS - 30))
        assert_equal 0, OpenReceivePayment.count_attempts_from_ip("203.0.113.2", Time.at(stamped + NINE_HOURS + 30))
      end
    end

    define_method("test_#{dialect.downcase}_expiry_closes_on_the_clock_nine_hours_from_nowhere") do
      with_tokyo_tables(dialect) do |_connection, _stored_text|
        grace = OpenReceive::Server::Reconciliation::EXPIRY_GRACE_SECONDS
        past = NOW - grace - 1
        in_grace = NOW - grace + 120
        live = NOW + 300
        commit("close-a", HASHES[:a], past - 600, past)
        commit("close-b", HASHES[:b], in_grace - 600, in_grace)
        commit("close-c", HASHES[:c], live - 600, live)

        wallet = Class.new do
          def list_transactions(_request)
            { "transactions" => [] }
          end
        end.new
        OpenReceive.configure do |config|
          config.authorize = ->(_context) { true }
          config.nwc_client = wallet
          config.amount_for = ->(_reference) { { "sats" => 100 } }
          config.on_paid = ->(_settlement) {}
          config.price_provider = false
          config.swap_providers = []
          config.opportunistic_reconcile = true
        end
        OpenReceive.reconcile!(now: NOW)
        statuses = HASHES.keys.to_h { |key| [key, OpenReceivePayment.find_by!(payment_hash: HASHES[key]).status] }
        assert_equal({ a: "expired", b: "pending", c: "pending" }, statuses)
      ensure
        OpenReceive.reset_config!
      end
    end

    define_method("test_#{dialect.downcase}_the_scan_window_finds_a_settled_invoice") do
      with_tokyo_tables(dialect) do |_connection, _stored_text|
        # The walk's window comes from created_at read back from the database: a
        # nine hour offset there would filter this invoice out of the history page.
        hash = HASHES[:a]
        expires = NOW + 600
        commit("window", hash, NOW, expires)
        row = { "type" => "incoming", "payment_hash" => hash, "invoice" => "lnbcfixture",
                "amount_msats" => 1000, "created_at" => NOW, "expires_at" => expires,
                "state" => "settled", "transaction_state" => "settled", "settled_at" => NOW + 5, "preimage" => "1" * 64 }
        wallet = Class.new do
          define_method(:list_transactions) do |request|
            from = request["from"] || request[:from]
            until_at = request["until"] || request[:until]
            inside = (from.nil? || NOW >= from) && (until_at.nil? || NOW <= until_at)
            { "transactions" => inside ? [row] : [] }
          end
        end.new
        fulfilled = []
        OpenReceive.configure do |config|
          config.authorize = ->(_context) { true }
          config.nwc_client = wallet
          config.amount_for = ->(_reference) { { "sats" => 100 } }
          config.on_paid = ->(settlement) { fulfilled << settlement.reference }
          config.price_provider = false
          config.swap_providers = []
        end
        OpenReceive.reconcile!(now: NOW + 10)
        assert_equal "settled", OpenReceivePayment.find_by!(payment_hash: hash).status
        assert_equal ["window"], fulfilled
      ensure
        OpenReceive.reset_config!
      end
    end

    define_method("test_#{dialect.downcase}_rows_round_trip_under_default_timezone_local") do
      with_tokyo_tables(dialect) do |_connection, _stored_text|
        previous = ActiveRecord.default_timezone
        begin
          ActiveRecord.default_timezone = :local
          commit("local", HASHES[:a], NOW - 60, NOW + 540)
          payment = OpenReceivePayment.find_by!(payment_hash: HASHES[:a])
          assert_equal NOW + 540, payment.expires_at.to_i
          assert_equal NOW - 60, payment.created_at.to_i
        ensure
          ActiveRecord.default_timezone = previous
        end
      end
    end
  end

  private

  def utc_text(unix_seconds)
    Time.at(unix_seconds).utc.strftime("%Y-%m-%d %H:%M:%S")
  end

  def commit(reference, hash, created_at, expires_at, client_ip: nil)
    checkout = { "reference" => reference, "payment_hash" => hash, "created_at" => created_at,
                 "expires_at" => expires_at, "amount_msats" => 1000, "bolt11" => "lnbcfixture" }
    OpenReceivePayment.commit_attempt!(reference: reference, payment_hash: hash, checkout: checkout, client_ip: client_ip)
    OpenReceivePayment.find_by!(payment_hash: hash)
  end

  def with_tokyo_tables(dialect)
    url = ENV["OPENRECEIVE_TEST_#{dialect}_URL"]
    skip "OPENRECEIVE_TEST_#{dialect}_URL not configured" if url.to_s.empty?
    parsed = URI.parse(url.sub("mysql+pymysql:", "mysql:"))
    name = "openreceive_nonutc_#{Process.pid}_#{dialect.downcase}"
    options = { adapter: dialect == "PGSQL" ? "postgresql" : "mysql2", host: parsed.host, port: parsed.port,
                username: parsed.user, password: parsed.password, database: parsed.path.delete_prefix("/"), pool: 4 }
    ActiveRecord::Base.establish_connection(options)
    admin = ActiveRecord::Base.connection
    if dialect == "PGSQL"
      admin.execute("CREATE SCHEMA #{name}")
      options[:schema_search_path] = name
    else
      admin.execute("CREATE DATABASE #{name}")
      options[:database] = name
    end
    previous_tz = ENV["TZ"]
    ENV["TZ"] = "America/New_York"
    begin
      ActiveRecord::Base.establish_connection(options)
      ActiveRecord::Schema.verbose = false
      ActiveRecord::Schema.define do
        create_table :openreceive_payments do |t|
          t.string :reference, null: false
          t.string :payment_hash, null: false, limit: 64
          t.string :status, null: false, default: "pending"
          t.string :status_reason
          t.datetime :paid_at
          t.datetime :expires_at, null: false
          t.json :checkout_data, null: false
          t.json :swap_data
          t.string :client_ip
          t.datetime :inserted_at, null: false
          t.timestamps
        end
        add_index :openreceive_payments, :payment_hash, unique: true
        create_table :openreceive_meta, id: false, primary_key: :key do |t|
          t.string :key, primary_key: true
          t.text :value, null: false
          t.bigint :rev, default: 0, null: false
        end
      end
      require_relative "../app/models/open_receive_meta"
      require_relative "../app/models/open_receive_payment"
      OpenReceiveMeta.reset_column_information
      OpenReceivePayment.reset_column_information
      OpenReceiveMeta.instance_variable_set(:@schema_version_checked, false)
      connection = ActiveRecord::Base.connection
      # Rails set this connection to UTC when it connected; put it back in Tokyo.
      if dialect == "PGSQL"
        connection.execute("SET TIME ZONE 'Asia/Tokyo'")
        assert_equal "Asia/Tokyo", connection.select_value("SHOW TimeZone")
      else
        connection.execute("SET time_zone = '+09:00'")
        assert_equal "+09:00", connection.select_value("SELECT @@session.time_zone")
      end
      stored_text = lambda do |conn, column, hash|
        quoted = conn.quote(hash)
        if dialect == "PGSQL"
          conn.select_value("SELECT to_char(#{column}, 'YYYY-MM-DD HH24:MI:SS') FROM openreceive_payments WHERE payment_hash = #{quoted}")
        else
          conn.select_value("SELECT DATE_FORMAT(#{column}, '%Y-%m-%d %H:%i:%s') FROM openreceive_payments WHERE payment_hash = #{quoted}")
        end
      end
      yield(connection, stored_text)
    ensure
      ENV["TZ"] = previous_tz
      ActiveRecord::Base.connection_pool.disconnect!
      ActiveRecord::Base.establish_connection(options.except(:schema_search_path).merge(database: parsed.path.delete_prefix("/")))
      if dialect == "PGSQL"
        ActiveRecord::Base.connection.execute("DROP SCHEMA #{name} CASCADE")
      else
        ActiveRecord::Base.connection.execute("DROP DATABASE #{name}")
      end
      ActiveRecord::Base.connection_pool.disconnect!
    end
  end
end
