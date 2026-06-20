import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENRECEIVE_AMOUNT_MSATS_BOUNDARY,
  OPENRECEIVE_ERROR_CODES,
  OPENRECEIVE_EVENT_NAMES,
  OPENRECEIVE_HTTP_OPERATION_IDS,
  OPENRECEIVE_HTTP_PATHS,
  OPENRECEIVE_TRANSACTION_STATES,
  OPENRECEIVE_WORKFLOW_STATES
} from "@openreceive/core";

test("generated contract models expose HTTP routes and event names", () => {
  assert.deepEqual(OPENRECEIVE_HTTP_PATHS, [
    "/capabilities",
    "/health",
    "/invoices",
    "/invoices/{invoice_id}",
    "/invoices/{invoice_id}/events",
    "/invoices/{invoice_id}/refresh",
    "/invoices/lookup",
    "/providers",
    "/rates",
    "/rates/quote",
    "/routes"
  ]);
  assert.deepEqual(OPENRECEIVE_HTTP_OPERATION_IDS, [
    "capabilities",
    "createInvoice",
    "getInvoice",
    "health",
    "invoiceEvents",
    "listProviders",
    "listRates",
    "listRoutes",
    "lookupInvoice",
    "quoteRates",
    "refreshInvoice"
  ]);
  assert.deepEqual(OPENRECEIVE_EVENT_NAMES, [
    "invoice.cancelled",
    "invoice.created",
    "invoice.expired",
    "invoice.failed",
    "invoice.settled",
    "invoice.settlement_action_completed",
    "invoice.verifying"
  ]);
  assert.deepEqual(OPENRECEIVE_ERROR_CODES, [
    "NOT_IMPLEMENTED",
    "RESTRICTED",
    "UNAUTHORIZED",
    "RATE_LIMITED",
    "QUOTA_EXCEEDED",
    "INTERNAL",
    "UNSUPPORTED_ENCRYPTION",
    "INSUFFICIENT_BALANCE",
    "PAYMENT_FAILED",
    "OTHER",
    "NOT_FOUND",
    "TIMEOUT",
    "INVALID_REQUEST",
    "WALLET_UNAVAILABLE",
    "INVOICE_EXPIRED",
    "UNSUPPORTED_METHOD",
    "CONFLICT"
  ]);
});

test("generated contract models expose shared state and amount boundaries", () => {
  assert.deepEqual(OPENRECEIVE_TRANSACTION_STATES, [
    "pending",
    "settled",
    "expired",
    "failed",
    "accepted"
  ]);
  assert.equal(OPENRECEIVE_WORKFLOW_STATES.includes("settlement_action_pending"), true);
  assert.deepEqual(OPENRECEIVE_AMOUNT_MSATS_BOUNDARY, {
    minimum: 1000,
    maximum: 9007199254740991
  });
});
