# frozen_string_literal: true

require "minitest/autorun"
require "erb"
require "openreceive/rails"

class StorageFreeRailsConfigTest < Minitest::Test
  def test_configuration_has_no_store_or_namespace
    config = OpenReceive::Configuration.new
    refute_respond_to config, :store
    refute_respond_to config, :namespace
    assert_respond_to config, :on_checkout_created
    refute_respond_to config, :token_keys
  end
end

class OpenReceiveRailsGeneratorTemplateTest < Minitest::Test
  TEMPLATE_ROOT = File.expand_path(
    "../lib/generators/openreceive/install/templates",
    __dir__
  )

  TemplateContext = Struct.new(
    :order_model_name,
    :order_table_name,
    :order_primary_key_type,
    :migration_version,
    :add_order_foreign_key?,
    keyword_init: true
  ) do
    def render(path)
      ERB.new(File.read(path), trim_mode: "-").result(binding)
    end
  end

  def setup
    @context = TemplateContext.new(
      order_model_name: "Order",
      order_table_name: "orders",
      order_primary_key_type: "bigint",
      migration_version: "7.1",
      add_order_foreign_key?: true
    )
  end

  def test_payment_model_template_is_multi_attempt_and_secret_safe
    rendered = @context.render(File.join(TEMPLATE_ROOT, "payment.rb"))
    assert_includes rendered, 'self.table_name = "openreceive_payments"'
    assert_includes rendered, "self.filter_attributes += [:swap_data]"
    assert_includes rendered, "order.with_lock"
    assert_includes rendered, "live_at(Time.current)"
    assert_includes rendered, 'super.except("swap_data")'
    RubyVM::InstructionSequence.compile(rendered)
  end

  def test_migration_has_many_attempts_per_order_without_unique_order_index
    rendered = @context.render(File.join(TEMPLATE_ROOT, "migration.rb"))
    assert_includes rendered, "t.bigint :order_id, null: false"
    assert_includes rendered, "add_index :openreceive_payments, :payment_hash, unique: true"
    refute_includes rendered, "[:order_id], unique: true"
    assert_includes rendered, "add_foreign_key :openreceive_payments, :orders"
    RubyVM::InstructionSequence.compile(rendered)
  end

  def test_initializer_uses_generated_payment_model
    rendered = @context.render(File.join(TEMPLATE_ROOT, "initializer.rb"))
    assert_includes rendered, "OpenReceivePayment.selected_for"
    assert_includes rendered, "OpenReceivePayment.commit_attempt!"
    assert_includes rendered, "OpenReceivePayment.mark_paid_once!"
    RubyVM::InstructionSequence.compile(rendered)
  end

  def test_generator_exposes_order_key_and_skip_options
    source = File.read(
      File.expand_path(
        "../lib/generators/openreceive/install/install_generator.rb",
        __dir__
      )
    )
    assert_includes source, "migration_template"
    assert_includes source, "order_primary_key_type"
    assert_includes source, "skip_payment_migration"
    assert_includes source, "skip_payment_model"
  end
end
