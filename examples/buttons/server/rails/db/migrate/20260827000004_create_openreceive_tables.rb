# frozen_string_literal: true

# Both engine-owned tables, in one migration: the payment attempts and the
# durable reconcile gate they share. Same host database, never a second one.
#
# Fulfilling exactly once
#
# WHAT OPENRECEIVE GUARANTEES
#
# Repository-backed settlement paths (wallet notifications, gated reconciliation,
# and explicit jobs) commit fulfillment for only the first settled attempt per
# reference. The library locks its `openreceive_payments` rows, decides the winner,
# and awaits your hook inside the same database transaction. A failure rolls
# back payment and host writes together; the hook can run again on a retry.
# A genuine second payment is still recorded with
# `status_reason = 'duplicate_settlement'`, without another fulfillment.
#
# Write an entitlement or an outbox job through the supplied transaction. Email,
# shipping APIs, and other external effects cannot commit atomically with it;
# your outbox worker must use durable idempotency for external delivery.
# A best-effort after-paid callback may be lost after commit and is not an outbox.
#
# Raw storage-free handlers do not provide this transaction: their on_paid hook
# may run on every settled poll. Those hosts own the durable conditional write
# or outbox themselves; process-local deduplication does not replace it.
#
# That makes the reference the unit of fulfillment: give every payable order
# its own reference, created before checkout, kept across retries, and never
# reused. A new checkout under a reference that has already settled is refused
# with a 409 rather than fulfilled again; a fresh reference per page load
# leaves one order payable twice.
#
# WHAT YOU MUST GUARANTEE
#
# OpenReceive cannot see fulfillment that happens outside it. If ANY other
# path can also mark this order fulfilled - an admin action, a second payment
# processor, a support tool, a replayed webhook, a retried background job -
# then those paths race each other, not OpenReceive, and you must make
# fulfillment idempotent yourself.
#
# The usual way is to make the transition itself the lock: guard it with a
# conditional write that only one transaction can win.
#
#   -- Idempotent by construction: the WHERE clause is the guard. Whoever
#   -- flips 'awaiting_payment' -> 'paid' first is the only one who fulfills;
#   -- every later attempt updates 0 rows and must do nothing.
#   UPDATE orders
#      SET state = 'paid', paid_at = :paid_at
#    WHERE id = :reference
#      AND state = 'awaiting_payment';
#   -- then: if 0 rows were affected, return without shipping anything.
#
# If your fulfillment is a read-modify-write that cannot be expressed as one
# conditional UPDATE, take a row lock for the duration instead:
#
#   SELECT * FROM orders WHERE id = :reference FOR UPDATE;  -- postgres/mysql
#   -- ...check state, grant entitlement/enqueue work, all before COMMIT.
#
# Run either one inside the transaction OpenReceive hands your settlement
# hook, so the order transition and the payment record commit together.
class CreateOpenReceiveTables < ActiveRecord::Migration[8.1]
  def change
    create_table :openreceive_payments do |t|
      # Your order id, as you passed it.
      t.string :reference, null: false
      t.string :payment_hash, null: false, limit: 64
      # Attempt lifecycle: pending | settled | expired | failed | attention.
      t.string :status, null: false, default: "pending"
      # Operator-facing detail for the current status (e.g. "superseded").
      t.string :status_reason
      t.datetime :paid_at
      t.datetime :expires_at, null: false
      # Safe checkout response used for retry without another wallet call.
      t.json :checkout_data, null: false
      # Server-only provider recovery data. Never return or log this column.
      t.json :swap_data
      # Client IP captured at invoice creation; backs optional per-IP rate limiting.
      t.string :client_ip
      # Immutable local-clock stamp the rate limiter windows on. created_at is
      # the wallet-reported invoice time (a skewed wallet clock would move the
      # window) and updated_at moves on every status transition (which would
      # re-enter an old attempt into the current window).
      t.datetime :inserted_at, null: false
      t.timestamps
    end

    add_index :openreceive_payments, :payment_hash, unique: true
    add_index :openreceive_payments, [:reference, :created_at]
    add_index :openreceive_payments, [:status, :created_at]
    add_index :openreceive_payments, [:client_ip, :inserted_at]

    # Engine-owned key/value/rev rows: the durable reconcile gate every worker
    # on this database shares, so settlement scans piggybacking on requests
    # collapse to one real wallet call per interval. Same host database as
    # openreceive_payments, never a second one.
    create_table :openreceive_meta, id: false do |t|
      t.string :key, null: false, primary_key: true
      t.text :value, null: false
      t.bigint :rev, null: false, default: 0
    end

    # Database-level backstops for the two invariants the engines enforce in
    # code, mirroring the JS paymentsSchemaSql. There is deliberately
    # NO uniqueness constraint over live attempts: liveness is time-dependent
    # (a superseded row stays pending with a future expires_at, and an expired
    # row stays pending until a wallet scan closes it), so any such index would
    # reject legitimate reminting.
    add_check_constraint :openreceive_payments,
                         "status IN ('pending', 'settled', 'expired', 'failed', 'attention')",
                         name: "openreceive_payments_status_check"
    hash_check =
      if connection.adapter_name.downcase.include?("postgres")
        "payment_hash ~ '^[0-9a-f]{64}$'"
      else
        "length(payment_hash) = 64 AND payment_hash NOT GLOB '*[^0-9a-f]*'"
      end
    add_check_constraint :openreceive_payments, hash_check,
                         name: "openreceive_payments_payment_hash_check"

    # Which schema generation is installed. The engine refuses to run against a
    # generation newer than the library it is linked with.
    reversible do |direction|
      direction.up do
        execute(<<~SQL.squish)
          INSERT INTO openreceive_meta (key, value, rev)
          VALUES ('schema_version', '1', 0)
          ON CONFLICT (key) DO NOTHING
        SQL
      end
    end
  end
end
