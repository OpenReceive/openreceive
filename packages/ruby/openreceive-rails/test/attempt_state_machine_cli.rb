# frozen_string_literal: true

# `npm run test:model` runs this: it replays a file of attempt-state-machine
# sequences and prints a JSON report of every result.

require_relative "attempt_state_machine_runner"

family = JSON.parse(File.read(ARGV.fetch(0)))
results = family.fetch("sequences").map do |sequence|
  run_attempt_state_machine_sequence(sequence)
end
puts JSON.generate(results)
