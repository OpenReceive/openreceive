import type {
  LookupInvoiceResult,
  OpenReceiveReceiveNwcClient
} from "../nwc/client.ts";
import {
  OPENRECEIVE_DEFAULT_GRACE_POLICY,
  pollInvoiceUntilFinalState,
  type PollingClock,
  type PollingGracePolicy,
  type SafePollingOutcome,
  type SafePollingTransition
} from "../polling/index.ts";
import type {
  InvoiceStorageRow,
  MaybePromise,
  OpenReceiveInvoiceStore
} from "../storage/index.ts";

export type OpenReceiveSettlementPollingRunnerEventName =
  | "invoice.verifying"
  | "invoice.settled"
  | "invoice.expired"
  | "invoice.failed"
  | "invoice.settlement_action_completed";

export interface OpenReceiveSettlementPollingRunnerEvent {
  event: OpenReceiveSettlementPollingRunnerEventName;
  invoice: InvoiceStorageRow;
  lookup_invoice?: LookupInvoiceResult;
  reason?: string;
}

export interface OpenReceiveSettlementActionInput {
  invoice: InvoiceStorageRow;
  lookup_invoice?: LookupInvoiceResult;
}

export interface OpenReceiveSettlementPollingRunnerOptions {
  client: OpenReceiveReceiveNwcClient;
  store: OpenReceiveInvoiceStore;
  settlementAction?: (input: OpenReceiveSettlementActionInput) => MaybePromise<void>;
  onEvent?: (event: OpenReceiveSettlementPollingRunnerEvent) => MaybePromise<void>;
  clock?: PollingClock;
  grace_policy?: PollingGracePolicy;
  recovery_interval_seconds?: number;
}

export interface OpenReceiveSettlementPollingRunnerRecovery {
  invoice_ids: string[];
  recovered: number;
}

export interface OpenReceiveSettlementPollingRunnerResult {
  invoice: InvoiceStorageRow;
  outcome: "settled" | "expired" | "failed" | "already_final" | "skipped";
  lookup_invoice?: LookupInvoiceResult;
  reason?: string;
}

export interface OpenReceiveSettlementPollingRunner {
  recoverOpenInvoices(): Promise<OpenReceiveSettlementPollingRunnerRecovery>;
  watchInvoice(invoiceId: string): Promise<OpenReceiveSettlementPollingRunnerResult>;
  pollInvoice(invoiceId: string): Promise<OpenReceiveSettlementPollingRunnerResult>;
  start(): void;
  stop(): void;
  activeInvoiceIds(): string[];
}

const DEFAULT_RECOVERY_INTERVAL_SECONDS = 30;

export function createOpenReceiveSettlementPollingRunner(
  options: OpenReceiveSettlementPollingRunnerOptions
): OpenReceiveSettlementPollingRunner {
  const clock = options.clock ?? systemPollingRunnerClock();
  const active = new Map<string, Promise<OpenReceiveSettlementPollingRunnerResult>>();
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const runner: OpenReceiveSettlementPollingRunner = {
    async recoverOpenInvoices() {
      const invoices = await options.store.listRecoverableInvoices({
        now: clock.now(),
        grace_seconds: getGraceWindowSeconds(options.grace_policy)
      });
      const invoiceIds = invoices.map((invoice) => invoice.invoice_id);

      for (const invoiceId of invoiceIds) {
        void runner.watchInvoice(invoiceId);
      }

      return {
        invoice_ids: invoiceIds,
        recovered: invoiceIds.length
      };
    },

    watchInvoice(invoiceId: string) {
      const existing = active.get(invoiceId);
      if (existing !== undefined) return existing;

      const task = runner.pollInvoice(invoiceId).finally(() => {
        active.delete(invoiceId);
      });
      active.set(invoiceId, task);
      return task;
    },

    async pollInvoice(invoiceId: string) {
      if (stopped) {
        const invoice = await options.store.getInvoice(invoiceId);
        return {
          invoice: requireInvoice(invoice, invoiceId),
          outcome: "skipped",
          reason: "runner_stopped"
        };
      }

      const invoice = requireInvoice(
        await options.store.getInvoice(invoiceId),
        invoiceId
      );

      if (isFinalInvoice(invoice)) {
        return {
          invoice,
          outcome: "already_final"
        };
      }

      if (invoice.transaction_state === "settled") {
        const completed = await runSettlementActionOnce(options, invoice);
        return {
          invoice: completed,
          outcome: "settled",
          reason: "settlement_action_recovered"
        };
      }

      const outcome = await pollInvoiceUntilFinalState({
        created_at: invoice.created_at,
        expires_at: invoice.expires_at,
        clock,
        grace_policy: options.grace_policy,
        lookup_invoice: () =>
          options.client.lookupInvoice({ payment_hash: invoice.payment_hash }),
        on_transition: (transition) =>
          applyPollingTransition(options, invoice.invoice_id, transition)
      });

      return await applyPollingOutcome(options, invoice, outcome);
    },

    start() {
      if (interval !== undefined) return;
      stopped = false;
      void runner.recoverOpenInvoices();
      interval = setInterval(() => {
        void runner.recoverOpenInvoices();
      }, getRecoveryIntervalSeconds(options) * 1000);
    },

    stop() {
      stopped = true;
      if (interval !== undefined) {
        clearInterval(interval);
        interval = undefined;
      }
    },

    activeInvoiceIds() {
      return [...active.keys()];
    }
  };

  return runner;
}

async function applyPollingTransition(
  options: OpenReceiveSettlementPollingRunnerOptions,
  invoiceId: string,
  transition: SafePollingTransition
): Promise<void> {
  if (transition.workflow_state === "verifying") {
    const invoice = await options.store.markVerifying(invoiceId);
    await emitRunnerEvent(options, {
      event: "invoice.verifying",
      invoice,
      reason: transition.reason
    });
    return;
  }

  await options.store.markExpiryPendingVerification(invoiceId);
}

async function applyPollingOutcome(
  options: OpenReceiveSettlementPollingRunnerOptions,
  invoice: InvoiceStorageRow,
  outcome: SafePollingOutcome
): Promise<OpenReceiveSettlementPollingRunnerResult> {
  if (outcome.status === "settled") {
    const settled = await options.store.markSettled({
      invoice_id: invoice.invoice_id,
      settled_at: outcome.lookup_invoice.settled_at
    });
    await emitRunnerEvent(options, {
      event: "invoice.settled",
      invoice: settled,
      lookup_invoice: outcome.lookup_invoice,
      reason: outcome.reason
    });
    const completed = await runSettlementActionOnce(
      options,
      settled,
      outcome.lookup_invoice
    );
    return {
      invoice: completed,
      outcome: "settled",
      lookup_invoice: outcome.lookup_invoice,
      reason: outcome.reason
    };
  }

  if (outcome.status === "expired") {
    const expired = await options.store.markExpiredClosed(invoice.invoice_id);
    await emitRunnerEvent(options, {
      event: "invoice.expired",
      invoice: expired,
      lookup_invoice: outcome.lookup_invoice,
      reason: outcome.reason
    });
    return {
      invoice: expired,
      outcome: "expired",
      lookup_invoice: outcome.lookup_invoice,
      reason: outcome.reason
    };
  }

  const failed = await options.store.markFailedClosed(invoice.invoice_id);
  await emitRunnerEvent(options, {
    event: "invoice.failed",
    invoice: failed,
    lookup_invoice: outcome.lookup_invoice,
    reason: outcome.reason
  });
  return {
    invoice: failed,
    outcome: "failed",
    lookup_invoice: outcome.lookup_invoice,
    reason: outcome.reason
  };
}

async function runSettlementActionOnce(
  options: OpenReceiveSettlementPollingRunnerOptions,
  invoice: InvoiceStorageRow,
  lookupInvoice?: LookupInvoiceResult
): Promise<InvoiceStorageRow> {
  if (
    invoice.workflow_state === "settlement_action_completed" ||
    invoice.settlement_action_state === "completed"
  ) {
    return invoice;
  }

  try {
    await options.settlementAction?.({
      invoice,
      lookup_invoice: lookupInvoice
    });
  } catch (error) {
    await options.store.markSettlementActionFailed(invoice.invoice_id);
    throw error;
  }

  const completed = await options.store.markSettlementActionCompleted({
    invoice_id: invoice.invoice_id,
    settlement_action_completed_at: options.clock?.now() ?? currentUnixSeconds()
  });
  await emitRunnerEvent(options, {
    event: "invoice.settlement_action_completed",
    invoice: completed,
    lookup_invoice: lookupInvoice
  });
  return completed;
}

async function emitRunnerEvent(
  options: OpenReceiveSettlementPollingRunnerOptions,
  event: OpenReceiveSettlementPollingRunnerEvent
): Promise<void> {
  await options.onEvent?.(event);
}

function requireInvoice(
  invoice: InvoiceStorageRow | undefined,
  invoiceId: string
): InvoiceStorageRow {
  if (invoice === undefined) {
    throw new Error(`OpenReceive polling runner could not find invoice ${invoiceId}`);
  }

  return invoice;
}

function isFinalInvoice(invoice: InvoiceStorageRow): boolean {
  return (
    invoice.workflow_state === "settlement_action_completed" ||
    invoice.workflow_state === "expired_closed" ||
    invoice.workflow_state === "failed_closed" ||
    invoice.workflow_state === "cancelled"
  );
}

function getGraceWindowSeconds(
  gracePolicy: PollingGracePolicy | undefined
): number {
  const policy = gracePolicy ?? OPENRECEIVE_DEFAULT_GRACE_POLICY;
  return policy.max_attempts * policy.delay_seconds;
}

function getRecoveryIntervalSeconds(
  options: OpenReceiveSettlementPollingRunnerOptions
): number {
  const seconds =
    options.recovery_interval_seconds ?? DEFAULT_RECOVERY_INTERVAL_SECONDS;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new TypeError("recovery_interval_seconds must be a positive safe integer");
  }
  return seconds;
}

function systemPollingRunnerClock(): PollingClock {
  const clock: PollingClock = {
    now: currentUnixSeconds,
    async sleep_until(timestampSeconds: number) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.max(0, timestampSeconds - clock.now()) * 1000);
      });
    }
  };

  return clock;
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
