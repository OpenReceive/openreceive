# frozen_string_literal: true

require "minitest/autorun"
require "uri"
require "json"
require "active_record"
require "openreceive/rails"

# Real DB acceptance: independent connections must serialize the reference and
# gate. Each lane owns its isolated test database/schema, never the host ledger.
class RepositoryDialectsTest < Minitest::Test
  %w[PGSQL MYSQL].each do |dialect|
    define_method("test_#{dialect.downcase}_transaction_and_gate_contract") do
      url = ENV["OPENRECEIVE_TEST_#{dialect}_URL"]
      skip "OPENRECEIVE_TEST_#{dialect}_URL not configured" if url.to_s.empty?
      parsed = URI.parse(url.sub("mysql+pymysql:", "mysql:"))
      name = "openreceive_ruby_#{Process.pid}_#{dialect.downcase}"
      options = { adapter: dialect == "PGSQL" ? "postgresql" : "mysql2", host: parsed.host, port: parsed.port,
        username: parsed.user, password: parsed.password, database: parsed.path.delete_prefix("/"), pool: 8 }
      ActiveRecord::Base.establish_connection(options)
      admin = ActiveRecord::Base.connection
      if dialect == "PGSQL"
        admin.execute("CREATE SCHEMA #{name}")
        options[:schema_search_path] = name
      else
        admin.execute("CREATE DATABASE #{name}")
        options[:database] = name
      end
      begin
        ActiveRecord::Base.establish_connection(options)
        ActiveRecord::Schema.verbose = false
        ActiveRecord::Schema.define do
          create_table :openreceive_payments do |t|
            t.string :reference, null: false
            t.string :payment_hash, null: false, limit: 64
            t.string :status, null: false
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
          create_table :entitlements, id: false do |t|
            t.string :reference, primary_key: true
          end
        end
        require_relative "../app/models/open_receive_meta"
        require_relative "../app/models/open_receive_payment"
        OpenReceiveMeta.reset_column_information
        OpenReceivePayment.reset_column_information
        OpenReceiveMeta.instance_variable_set(:@schema_version_checked, false)
        now = Time.now.to_i
        hash = "1" * 64
        checkout = { "reference" => "one", "payment_hash" => hash, "created_at" => now, "expires_at" => now + 1800, "amount_msats" => 1000, "bolt11" => "lnbcfixture" }
        OpenReceivePayment.commit_attempt!(reference: "one", payment_hash: hash, checkout: checkout)
        if dialect == "MYSQL"
          ActiveRecord::Base.transaction do
            error = assert_raises(RuntimeError) do
              OpenReceivePayment.mark_paid_once!(payment_hash: hash, paid_at: now + 1)
            end
            assert_match(/outermost transaction/, error.message)
          end
          assert_equal "pending", OpenReceivePayment.find_by!(payment_hash: hash).status
        end
        transition_thread = nil
        OpenReceivePayment.with_reference_lock("one") do
          ready = Queue.new
          transition_thread = Thread.new do
            ActiveRecord::Base.connection_pool.with_connection do
              ready << true
              OpenReceivePayment.record_reconciliation!(payment_hash: hash, status: "attention", observed_at: now, reason: "fixture_review")
            end
          end
          ready.pop
          assert_nil transition_thread.join(0.1), "terminal transition must wait for the same reference lock"
        end
        transition_thread.join
        assert_equal "attention", OpenReceivePayment.find_by!(payment_hash: hash).status
        assert_nil OpenReceivePayment.mark_paid_once!(payment_hash: "f" * 64, paid_at: now)
        OpenReceivePayment.find_by!(payment_hash: hash).update!(status: "pending", status_reason: nil)
        assert_raises(RuntimeError) do
          OpenReceivePayment.mark_paid_once!(payment_hash: hash, paid_at: now + 1) { raise "rollback" }
        end
        assert_equal "pending", OpenReceivePayment.find_by!(payment_hash: hash).status
        errors = Queue.new
        workers = 4.times.map do
          Thread.new do
            ActiveRecord::Base.connection_pool.with_connection do |connection|
              OpenReceivePayment.mark_paid_once!(payment_hash: hash, paid_at: now + 2) do
                connection.execute("INSERT INTO entitlements (reference) VALUES ('one')")
              end
            rescue StandardError => e
              errors << e
            end
          end
        end
        workers.each(&:join)
        raise errors.pop unless errors.empty?
        assert_equal 1, ActiveRecord::Base.connection.select_value("SELECT COUNT(*) FROM entitlements").to_i
        assert_equal "settled", OpenReceivePayment.find_by!(payment_hash: hash).status
        claims = Queue.new
        workers = 4.times.map do
          Thread.new do
            ActiveRecord::Base.connection_pool.with_connection do
              claims << OpenReceiveMeta.claim_reconcile_gate(now: now, interval_seconds: 2)
            end
          end
        end
        workers.each(&:join)
        won = 4.times.map { claims.pop }.compact
        assert_equal 1, won.length
        newer = OpenReceiveMeta.claim_reconcile_gate(now: now + 11, interval_seconds: 2)
        refute_nil newer
        refute OpenReceiveMeta.checkpoint_reconcile_gate(won.first, won.first.fetch("scheduler"), now: now + 11)
      ensure
        ActiveRecord::Base.establish_connection(options.merge(database: parsed.path.delete_prefix("/"), schema_search_path: "public"))
        ActiveRecord::Base.connection.execute(dialect == "PGSQL" ? "DROP SCHEMA #{name} CASCADE" : "DROP DATABASE #{name}")
        ActiveRecord::Base.connection_pool.disconnect!
      end
    end
  end
end
