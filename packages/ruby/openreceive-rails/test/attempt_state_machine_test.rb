# frozen_string_literal: true

require "minitest/autorun"
require_relative "attempt_state_machine_runner"

# The generated attempt-state-machine vectors, replayed against the real
# OpenReceivePayment model and reconcile path.
class AttemptStateMachineTest < Minitest::Test
  FAMILY = JSON.parse(
    File.read(File.expand_path("../../../../spec/test-vectors/attempt-state-machine.json", __dir__))
  )

  def test_vector_constants_match_the_engine
    assert_equal FAMILY["expiry_grace_seconds"], OpenReceive::Server::Reconciliation::EXPIRY_GRACE_SECONDS
    assert_equal FAMILY["reuse_buffer_seconds"], OpenReceivePayment::REUSE_BUFFER_SECONDS
  end

  FAMILY.fetch("sequences").each do |sequence|
    define_method("test_#{sequence.fetch('name').tr('-', '_')}") do
      result = run_attempt_state_machine_sequence(sequence)
      assert result["ok"], "#{result} at step: #{sequence['steps'][result['step'] || 0]}"
    end
  end
end
