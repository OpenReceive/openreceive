import type {
  LookupInvoiceResult,
  OpenReceiveWorkflowState
} from "../nwc/client.ts";
import { classifyLookupInvoiceSettlement } from "../settlement/index.ts";

export interface PollingCadenceBand {
  elapsed_seconds_min: number;
  elapsed_seconds_max: number;
  delay_seconds: number;
}

export interface PollingClock {
  now(): number;
  sleep_until(timestamp_seconds: number): Promise<void>;
}

export interface PollingGracePolicy {
  max_attempts: number;
  delay_seconds: number;
}

export interface GraceLookupAttempt {
  attempt: number;
  delay_seconds: number;
  lookup_at: number;
}

export type PollingScheduleReason =
  | "cadence"
  | "local_expiry"
  | "final_lookup";

export type PollingScheduleDecision =
  | {
      action: "schedule_lookup";
      reason: "cadence";
      next_lookup_at: number;
      delay_seconds: number;
    }
  | {
      action: "schedule_final_lookup";
      reason: "local_expiry";
      next_lookup_at: number;
      delay_seconds: number;
    }
  | {
      action: "final_lookup";
      reason: "final_lookup";
      next_lookup_at: number;
      delay_seconds: 0;
    };

export type SafePollingOutcomeStatus = "settled" | "expired" | "failed";

export interface SafePollingOutcome {
  status: SafePollingOutcomeStatus;
  workflow_state: OpenReceiveWorkflowState;
  lookup_invoice: LookupInvoiceResult;
  reason:
    | "settlement_detected"
    | "wallet_expired"
    | "wallet_failed"
    | "grace_exhausted";
}

export type SafePollingTransition =
  | {
      workflow_state: "verifying";
      reason: "poll_lookup" | "final_lookup" | "grace_lookup";
      attempt?: number;
    }
  | {
      workflow_state: "expiry_pending_verification";
      reason: "wallet_truth_inconclusive";
    };

export interface SafePollingOptions {
  created_at: number;
  expires_at: number;
  lookup_invoice(): Promise<LookupInvoiceResult>;
  clock?: PollingClock | undefined;
  grace_policy?: PollingGracePolicy | undefined;
  on_transition?:
    | ((transition: SafePollingTransition) => Promise<void> | void)
    | undefined;
}

export const OPENRECEIVE_POLLING_CADENCE: readonly PollingCadenceBand[] = [
  {
    elapsed_seconds_min: 0,
    elapsed_seconds_max: 14,
    delay_seconds: 2
  },
  {
    elapsed_seconds_min: 15,
    elapsed_seconds_max: 59,
    delay_seconds: 5
  },
  {
    elapsed_seconds_min: 60,
    elapsed_seconds_max: 179,
    delay_seconds: 10
  },
  {
    elapsed_seconds_min: 180,
    elapsed_seconds_max: 599,
    delay_seconds: 20
  }
] as const;

export const OPENRECEIVE_DEFAULT_GRACE_POLICY: PollingGracePolicy = {
  max_attempts: 3,
  delay_seconds: 5
} as const;

export function getPollingElapsedSeconds(input: {
  created_at: number;
  now: number;
}): number {
  assertIntegerSeconds(input.created_at, "created_at");
  assertIntegerSeconds(input.now, "now");
  return Math.max(0, input.now - input.created_at);
}

export function getPollingDelaySeconds(input: {
  created_at: number;
  now: number;
}): number {
  const elapsed = getPollingElapsedSeconds(input);
  const cadenceBand = OPENRECEIVE_POLLING_CADENCE.find(
    (band) =>
      elapsed >= band.elapsed_seconds_min &&
      elapsed <= band.elapsed_seconds_max
  );

  if (cadenceBand !== undefined) return cadenceBand.delay_seconds;

  const lastBand =
    OPENRECEIVE_POLLING_CADENCE[OPENRECEIVE_POLLING_CADENCE.length - 1];

  if (lastBand === undefined) {
    throw new Error("OpenReceive polling cadence must not be empty");
  }

  return lastBand.delay_seconds;
}

export function getNextLookupAt(input: {
  created_at: number;
  expires_at: number;
  now: number;
}): number {
  return getPollingSchedule(input).next_lookup_at;
}

export function getPollingSchedule(input: {
  created_at: number;
  expires_at: number;
  now: number;
}): PollingScheduleDecision {
  assertInvoiceTimes(input.created_at, input.expires_at);
  assertIntegerSeconds(input.now, "now");

  if (input.now >= input.expires_at) {
    return {
      action: "final_lookup",
      reason: "final_lookup",
      next_lookup_at: input.now,
      delay_seconds: 0
    };
  }

  const effectiveNow = Math.max(input.now, input.created_at);
  const delaySeconds = getPollingDelaySeconds({
    created_at: input.created_at,
    now: effectiveNow
  });
  const nextLookupAt = effectiveNow + delaySeconds;

  if (nextLookupAt >= input.expires_at) {
    return {
      action: "schedule_final_lookup",
      reason: "local_expiry",
      next_lookup_at: input.expires_at,
      delay_seconds: input.expires_at - input.now
    };
  }

  return {
    action: "schedule_lookup",
    reason: "cadence",
    next_lookup_at: nextLookupAt,
    delay_seconds: nextLookupAt - input.now
  };
}

export function getGraceLookupSchedule(input: {
  expires_at: number;
  now: number;
  grace_policy?: PollingGracePolicy | undefined;
}): GraceLookupAttempt[] {
  assertIntegerSeconds(input.expires_at, "expires_at");
  assertIntegerSeconds(input.now, "now");

  const policy = normalizeGracePolicy(input.grace_policy);
  const startAt = Math.max(input.expires_at, input.now);
  const attempts: GraceLookupAttempt[] = [];

  for (let attempt = 1; attempt <= policy.max_attempts; attempt += 1) {
    attempts.push({
      attempt,
      delay_seconds: policy.delay_seconds,
      lookup_at: startAt + policy.delay_seconds * attempt
    });
  }

  return attempts;
}

export async function pollInvoiceUntilFinalState(
  options: SafePollingOptions
): Promise<SafePollingOutcome> {
  assertInvoiceTimes(options.created_at, options.expires_at);

  const clock = options.clock ?? systemPollingClock();

  while (clock.now() < options.expires_at) {
    const schedule = getPollingSchedule({
      created_at: options.created_at,
      expires_at: options.expires_at,
      now: clock.now()
    });

    await clock.sleep_until(schedule.next_lookup_at);

    if (clock.now() >= options.expires_at) break;

    await emitTransition(options, {
      workflow_state: "verifying",
      reason: "poll_lookup"
    });

    const lookup = await options.lookup_invoice();
    const outcome = getFinalOutcome(lookup);
    if (outcome !== undefined) return outcome;
  }

  await emitTransition(options, {
    workflow_state: "verifying",
    reason: "final_lookup"
  });

  let latestLookup = await options.lookup_invoice();
  const finalOutcome = getFinalOutcome(latestLookup);
  if (finalOutcome !== undefined) return finalOutcome;

  await emitTransition(options, {
    workflow_state: "expiry_pending_verification",
    reason: "wallet_truth_inconclusive"
  });

  const graceScheduleInput: {
    expires_at: number;
    now: number;
    grace_policy?: PollingGracePolicy | undefined;
  } = {
    expires_at: options.expires_at,
    now: clock.now()
  };

  if (options.grace_policy !== undefined) {
    graceScheduleInput.grace_policy = options.grace_policy;
  }

  for (const attempt of getGraceLookupSchedule(graceScheduleInput)) {
    await clock.sleep_until(attempt.lookup_at);
    await emitTransition(options, {
      workflow_state: "verifying",
      reason: "grace_lookup",
      attempt: attempt.attempt
    });

    latestLookup = await options.lookup_invoice();
    const graceOutcome = getFinalOutcome(latestLookup);
    if (graceOutcome !== undefined) return graceOutcome;
  }

  return {
    status: "expired",
    workflow_state: "expired_closed",
    lookup_invoice: latestLookup,
    reason: "grace_exhausted"
  };
}

function getFinalOutcome(
  lookup: LookupInvoiceResult
): SafePollingOutcome | undefined {
  const detection = classifyLookupInvoiceSettlement(lookup);

  if (detection.status === "settled") {
    return {
      status: "settled",
      workflow_state: "settlement_action_pending",
      lookup_invoice: lookup,
      reason: "settlement_detected"
    };
  }

  if (detection.status === "expired") {
    return {
      status: "expired",
      workflow_state: "expired_closed",
      lookup_invoice: lookup,
      reason: "wallet_expired"
    };
  }

  if (detection.status === "failed") {
    return {
      status: "failed",
      workflow_state: "failed_closed",
      lookup_invoice: lookup,
      reason: "wallet_failed"
    };
  }

  return undefined;
}

async function emitTransition(
  options: SafePollingOptions,
  transition: SafePollingTransition
): Promise<void> {
  await options.on_transition?.(transition);
}

function systemPollingClock(): PollingClock {
  const clock: PollingClock = {
    now() {
      return Math.floor(Date.now() / 1000);
    },
    async sleep_until(timestampSeconds: number) {
      await sleepSeconds(Math.max(0, timestampSeconds - clock.now()));
    }
  };

  return clock;
}

async function sleepSeconds(seconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

function normalizeGracePolicy(
  policy: PollingGracePolicy | undefined
): PollingGracePolicy {
  const normalized = policy ?? OPENRECEIVE_DEFAULT_GRACE_POLICY;
  assertNonNegativeInteger(normalized.max_attempts, "grace_policy.max_attempts");
  assertPositiveInteger(normalized.delay_seconds, "grace_policy.delay_seconds");
  return normalized;
}

function assertInvoiceTimes(createdAt: number, expiresAt: number): void {
  assertIntegerSeconds(createdAt, "created_at");
  assertIntegerSeconds(expiresAt, "expires_at");

  if (expiresAt < createdAt) {
    throw new RangeError("expires_at must be greater than or equal to created_at");
  }
}

function assertIntegerSeconds(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer Unix timestamp in seconds`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}
