import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS,
  OPENRECEIVE_ATTEMPT_REUSE_BUFFER_SECONDS,
} from "../packages/js/http/src/payment-repository.ts";
import { runSequence } from "./helpers/attempt-state-machine-runner.mjs";
import { vectorFileText, VECTOR_COUNT, VECTOR_SEED } from "../tools/attempt-model/generate.mjs";

const family = JSON.parse(readFileSync("spec/test-vectors/attempt-state-machine.json", "utf8"));

test("the attempt state machine vector file is exactly the model's output", () => {
  assert.equal(family.expiry_grace_seconds, OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS);
  assert.equal(family.reuse_buffer_seconds, OPENRECEIVE_ATTEMPT_REUSE_BUFFER_SECONDS);
  assert.equal(family.generator.seed, VECTOR_SEED);
  assert.equal(family.sequences.length, VECTOR_COUNT);
  assert.equal(
    readFileSync("spec/test-vectors/attempt-state-machine.json", "utf8"),
    vectorFileText(),
    "regenerate with `npm run generate:model-vectors` after a model change",
  );
});

// The corpus is random but it must keep hitting the behaviors the rules are about.
test("the vector corpus covers every state machine behavior", () => {
  const required = [
    "status:settled",
    "status:expired",
    "status:failed",
    "status:attention",
    "reason:not_found_after_expiry",
    "reason:no_finality_after_expiry",
    "reason:unsettled_after_expiry",
    "reason:wallet_reported_failed",
    "reason:wallet_reported_expired",
    "reason:duplicate_settlement",
    "reason:superseded",
    "outcome:create:inserted",
    "outcome:create:reused",
    "outcome:create:already_paid",
    "outcome:commit:inserted",
    "outcome:commit:idempotent",
    "outcome:commit:conflict",
    "op:restart",
    "op:replay_settlement",
    "op:stale_close",
    "scan:ok",
    "scan:fail",
    "scan:unrecognized_key",
    "scan:unrecognized_type",
    "scan:unusable_rows",
    "scan:fail_after_1",
    "scan:fail_after_2",
    "notify:received:settled_at",
    "notify:received:state",
    "notify:received:preimage",
    "notify:received:none",
    "notify:received:absent",
    "notify:sent:settled_at",
    "wallet:settled_at",
    "wallet:settled_state",
    "wallet:settled_full",
    "wallet:absent",
    "wallet:stateless",
    "wallet:pending",
    "wallet:accepted",
    "wallet:failed",
    "wallet:expired",
    "late_payment_on_closed",
    "notify:hash_unknown_at_delivery",
    "notify:row_created_after_notification",
    "boundary:closed_exactly_at_expiry_plus_grace",
    "boundary:still_open_one_second_before_grace",
    "fail_fulfillment",
    "fulfilled",
  ];
  const missing = required.filter((tag) => (family.coverage[tag] ?? 0) === 0);
  assert.deepEqual(missing, []);
});

for (const sequence of family.sequences) {
  test(`attempt state machine: ${sequence.name}`, async () => {
    const result = await runSequence(sequence);
    assert.equal(
      result.ok,
      true,
      `${sequence.name} step ${result.step} (${result.kind}): ${result.message}\n` +
        `step: ${JSON.stringify(sequence.steps[result.step] ?? null)}`,
    );
  });
}
